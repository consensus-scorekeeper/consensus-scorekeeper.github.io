// Roster management on the setup screen.
//
// Two modes for the team-name field:
//   * custom (default) — a free-text <input>. The toggle in the top-right
//                        reads "Custom rosters [ON]" in this mode.
//   * preset           — a <select> populated from the chosen tournament's
//                        rosters; picking a team auto-fills the player list.
//                        When this mode is active, a tournament dropdown
//                        appears next to the toggle so the moderator can
//                        switch between past tournaments' roster sets.
//
// Persistence:
//   * consensus-roster-mode-v1     ← 'custom' | 'preset' (default: 'custom').
//                                    Old value 'tournament' is migrated to
//                                    'preset' on read.
//   * consensus-tournament-slug-v1 ← which tournament drives the team-name
//                                    <select> in preset mode (defaults to
//                                    DEFAULT_TOURNAMENT.slug).
//
// Toggling re-renders both team-name slots (#team-a-name-slot /
// #team-b-name-slot) and re-binds listeners — the active element keeps its
// stable id (`team-${team}-name`) so other modules (loadState, tutorial.js,
// ui/game.js startGame) don't need to care which mode is active.
//
// Add/remove player buttons and the player-name autocomplete are
// mode-independent and always available.

import { state } from '../state.js';
import { escapeHtml } from '../util/escape.js';
import { saveState } from '../game/persistence.js';
import { TOURNAMENTS, DEFAULT_TOURNAMENT, playerSuggestionsFor } from './roster-presets.js';
import {
  loadCustomTournaments,
  getAnyTournamentBySlug,
} from './custom-tournaments.js';
import { attachDragReorder } from './drag-reorder.js';

const ROSTER_MODE_KEY = 'consensus-roster-mode-v1';
const TOURNAMENT_SLUG_KEY = 'consensus-tournament-slug-v1';
const PLACEHOLDER_VALUE = '';
let rosterMode = readPersistedMode();
let selectedTournamentSlug = readPersistedTournamentSlug();

function readPersistedMode() {
  try {
    const v = localStorage.getItem(ROSTER_MODE_KEY);
    // Migrate the legacy 'tournament' value (used before multi-tournament
    // support) to the new 'preset' name.
    if (v === 'preset' || v === 'tournament') return 'preset';
    if (v === 'custom') return 'custom';
    return 'custom';
  } catch { return 'custom'; }
}

function readPersistedTournamentSlug() {
  try {
    const v = localStorage.getItem(TOURNAMENT_SLUG_KEY);
    if (v && getAnyTournamentBySlug(v)) return v;
  } catch { /* ignore */ }
  return DEFAULT_TOURNAMENT.slug;
}

function currentTournament() {
  return getAnyTournamentBySlug(selectedTournamentSlug) || DEFAULT_TOURNAMENT;
}

export function getRosterMode() { return rosterMode; }

// Slug of the tournament currently driving preset rosters, or '' in
// custom mode (a manually built roster isn't tied to any tournament).
export function getSelectedTournamentSlug() {
  return rosterMode === 'preset' ? selectedTournamentSlug : '';
}

export function addPlayer(team) {
  const input = document.getElementById(`add-player-${team}`);
  const name = input.value.trim();
  if (!name) return;
  const teamObj = team === 'a' ? state.teamA : state.teamB;
  teamObj.players.push({ name, points: 0 });
  input.value = '';
  renderRoster(team);
  input.focus();
  saveState();
}

export function removePlayer(team, index) {
  const teamObj = team === 'a' ? state.teamA : state.teamB;
  teamObj.players.splice(index, 1);
  renderRoster(team);
  saveState();
}

export function renderRoster(team) {
  const teamObj = team === 'a' ? state.teamA : state.teamB;
  const list = document.getElementById(`roster-${team}`);
  if (!list) return;
  list.innerHTML = teamObj.players.map((p, i) =>
    `<li class="roster-item" draggable="true" data-team="${team}" data-index="${i}">` +
      `<span class="drag-handle" aria-hidden="true" title="Drag to reorder">&#x2630;</span>` +
      `<span class="roster-name">${escapeHtml(p.name)}</span>` +
      `<button draggable="false" data-action="remove-player" data-team="${team}" data-index="${i}" title="Remove player">&times;</button>` +
    `</li>`
  ).join('');
}

function buildTeamSelectMarkup(team) {
  const tournament = currentTournament();
  const opts = [`<option value="${PLACEHOLDER_VALUE}">— Pick a team —</option>`];
  for (const preset of tournament.rosters) {
    opts.push(`<option value="${escapeHtml(preset.name)}">${escapeHtml(preset.name)}</option>`);
  }
  return `<select id="team-${team}-name">${opts.join('')}</select>`;
}

function buildTeamInputMarkup(team, currentName) {
  const safe = escapeHtml(currentName || '');
  return `<input type="text" id="team-${team}-name" value="${safe}" placeholder="Team name">`;
}

function populatePlayerSuggestions() {
  const dl = document.getElementById('player-suggestions');
  if (!dl) return;
  // Suggestions are the selected tournament's player list — names from
  // other tournaments would be noise (the moderator is running THIS one).
  // In custom mode the user isn't drafting from a preset roster at all,
  // so the datalist is emptied instead.
  if (rosterMode !== 'preset') {
    dl.innerHTML = '';
    return;
  }
  dl.innerHTML = playerSuggestionsFor(currentTournament())
    .map((name) => `<option value="${escapeHtml(name)}"></option>`)
    .join('');
}

// Render the team-name field in `team`'s slot for the current mode.
// The previous element (and its listeners) is dropped because innerHTML
// replaces the contents — listeners are re-bound here. The displayed
// value isn't set here: in custom mode, buildTeamInputMarkup already bakes
// in state.teamX.name; in preset mode we want a fresh load to show
// the placeholder. Callers that want to carry a name across a toggle
// (toggleRosterMode) call setTeamNameField after this returns.
function renderTeamNameField(team) {
  const slot = document.getElementById(`team-${team}-name-slot`);
  if (!slot) return;
  const teamObj = team === 'a' ? state.teamA : state.teamB;
  slot.innerHTML = rosterMode === 'preset'
    ? buildTeamSelectMarkup(team)
    : buildTeamInputMarkup(team, teamObj.name);

  const el = document.getElementById(`team-${team}-name`);
  if (!el) return;

  if (rosterMode === 'preset') {
    el.addEventListener('change', (e) => applyPreset(team, e.target.value));
  } else {
    el.addEventListener('input', (e) => {
      const obj = team === 'a' ? state.teamA : state.teamB;
      obj.name = e.target.value;
      saveState();
    });
  }
}

// Set the team-name field to display `name`, regardless of mode.
//   - In preset mode: select the matching preset, or inject a one-off
//     <option data-dynamic="true"> if the name isn't a preset (saved
//     sessions, tutorial sandbox, or a name from a different tournament).
//   - In custom mode: just write to the input's value.
export function setTeamNameField(team, name) {
  const el = document.getElementById(`team-${team}-name`);
  if (!el) return;
  if (el.tagName !== 'SELECT') {
    el.value = name || '';
    return;
  }
  if (!name) { el.value = PLACEHOLDER_VALUE; return; }
  // Skip the boilerplate default names — they're meaningless in preset
  // mode and we don't want them to clutter the dropdown as dynamic options.
  // The user can pick a real preset; until then the placeholder stays.
  const defaultName = team === 'a' ? 'Team A' : 'Team B';
  if (name === defaultName) { el.value = PLACEHOLDER_VALUE; return; }
  const stale = el.querySelector('option[data-dynamic="true"]');
  if (stale) stale.remove();
  const matches = Array.from(el.options).some((o) => o.value === name);
  if (!matches) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    opt.dataset.dynamic = 'true';
    el.insertBefore(opt, el.options[1] || null);
  }
  el.value = name;
}

function applyPreset(team, presetName) {
  const teamObj = team === 'a' ? state.teamA : state.teamB;
  const preset = currentTournament().rosters.find((p) => p.name === presetName);
  if (preset) {
    teamObj.name = preset.name;
    teamObj.players = preset.players.map((name) => ({ name, points: 0 }));
  } else {
    teamObj.name = '';
    teamObj.players = [];
  }
  teamObj.score = 0;
  renderRoster(team);
  saveState();
}

function syncToggleLabel() {
  // The label is always "Tournament rosters"; the switch reads ON when a
  // tournament's preset rosters are active (preset mode) and OFF when the
  // moderator is typing custom team names. The tournament-picker dropdown
  // is only visible alongside ON.
  const label = document.getElementById('roster-mode-label');
  if (label) label.textContent = 'Tournament rosters';
  const btn = document.getElementById('roster-mode-toggle');
  if (btn) {
    btn.dataset.mode = rosterMode;
    const presetOn = rosterMode === 'preset';
    btn.setAttribute('aria-pressed', presetOn ? 'true' : 'false');
    btn.setAttribute('title', presetOn
      ? "Turn off tournament rosters (type custom team names)"
      : "Turn on tournament rosters (pick from a tournament's preset teams)");
  }
  const stateLabel = document.getElementById('roster-mode-switch-state');
  if (stateLabel) stateLabel.textContent = rosterMode === 'preset' ? 'ON' : 'OFF';
  // Mirror onto #setup so CSS-only sections (e.g. #tournament-stats-section)
  // can show/hide themselves based on mode without needing to coordinate
  // with this module.
  const setup = document.getElementById('setup');
  if (setup) setup.dataset.rosterMode = rosterMode;
  syncTournamentPicker();
}

// Populate and toggle visibility of the tournament-picker dropdown shown
// when preset mode is active. Rebuilt unconditionally on every call: the
// list is tiny, the change listener lives on the <select> itself (so it
// survives innerHTML), and custom tournaments can appear/rename/vanish at
// runtime via the roster manager. Custom entries render in their own
// optgroup so it's obvious which rosters are user-created.
function syncTournamentPicker() {
  const picker = document.getElementById('roster-tournament-picker');
  const sel = document.getElementById('roster-tournament-select');
  if (!picker || !sel) return;
  const optionMarkup = (t) =>
    `<option value="${escapeHtml(t.slug)}">${escapeHtml(t.name)}</option>`;
  const custom = loadCustomTournaments();
  let html = TOURNAMENTS.map(optionMarkup).join('');
  if (custom.length) {
    html = `<optgroup label="Built-in">${html}</optgroup>` +
      `<optgroup label="My tournaments">${custom.map(optionMarkup).join('')}</optgroup>`;
  }
  sel.innerHTML = html;
  sel.value = selectedTournamentSlug;
  picker.hidden = rosterMode !== 'preset';
}

export function toggleRosterMode() {
  rosterMode = rosterMode === 'custom' ? 'preset' : 'custom';
  try { localStorage.setItem(ROSTER_MODE_KEY, rosterMode); } catch {}
  syncToggleLabel();
  populatePlayerSuggestions();
  // After re-rendering, carry whatever name lives in state into the new
  // field so a custom-typed name isn't dropped on toggle. In preset mode
  // this also preserves a non-preset name as a one-off <option>.
  renderTeamNameField('a');
  renderTeamNameField('b');
  setTeamNameField('a', state.teamA.name);
  setTeamNameField('b', state.teamB.name);
}

// User picked a different tournament from the dropdown. Repopulate the
// team-name <select>s with the new tournament's rosters; clear any team
// names that aren't part of the new roster set (they wouldn't match any
// option and would clutter the dropdown as a dynamic entry).
function setSelectedTournamentSlug(slug) {
  selectedTournamentSlug = slug;
  try { localStorage.setItem(TOURNAMENT_SLUG_KEY, slug); } catch {}
}

function applySelectedTournament(slug) {
  if (!getAnyTournamentBySlug(slug)) return;
  setSelectedTournamentSlug(slug);
  // Clearing the team is the safest move — keeping a stale team name
  // would mismatch the new tournament's roster, and the moderator can
  // pick again from the freshly-populated dropdown.
  for (const t of ['a', 'b']) {
    const teamObj = t === 'a' ? state.teamA : state.teamB;
    teamObj.name = '';
    teamObj.players = [];
    teamObj.score = 0;
    renderRoster(t);
  }
  renderTeamNameField('a');
  renderTeamNameField('b');
  populatePlayerSuggestions();
  saveState();
}

// Called by the roster manager after a custom tournament is created,
// edited, or deleted, so the picker + autocomplete reflect the change.
//   - If the selected tournament vanished (deleted): fall back to the
//     default. In preset mode that goes through applySelectedTournament
//     (clears teams, same semantics as a manual switch); in custom mode we
//     only update the persisted slug — never clobber a hand-built roster
//     over background bookkeeping.
//   - If the currently selected tournament was edited (mutatedSlug): re-apply
//     it in preset mode so the team dropdowns repopulate from the new rosters.
export function refreshTournamentPicker({ mutatedSlug } = {}) {
  if (!getAnyTournamentBySlug(selectedTournamentSlug)) {
    if (rosterMode === 'preset') {
      applySelectedTournament(DEFAULT_TOURNAMENT.slug);
    } else {
      setSelectedTournamentSlug(DEFAULT_TOURNAMENT.slug);
    }
  } else if (mutatedSlug && mutatedSlug === selectedTournamentSlug && rosterMode === 'preset') {
    applySelectedTournament(selectedTournamentSlug);
  }
  syncTournamentPicker();
}

export function setupSetupScreen() {
  populatePlayerSuggestions();
  syncToggleLabel();
  renderTeamNameField('a');
  renderTeamNameField('b');

  // Tournament-picker change handler. The element is rendered into the
  // DOM by index.html (hidden by default); syncTournamentPicker populates
  // its options the first time it runs.
  const tournamentSel = document.getElementById('roster-tournament-select');
  if (tournamentSel) {
    tournamentSel.addEventListener('change', (e) => applySelectedTournament(e.target.value));
  }

  const addA = document.getElementById('add-player-a');
  const addB = document.getElementById('add-player-b');
  if (addA) addA.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPlayer('a'); });
  if (addB) addB.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPlayer('b'); });

  // Roster <button> uses data-action so we can keep using event delegation
  // without inline onclick. The roster list is re-rendered (innerHTML) on
  // every change, so this delegated listener is the right place to bind.
  for (const team of ['a', 'b']) {
    const list = document.getElementById(`roster-${team}`);
    if (!list) continue;
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action="remove-player"]');
      if (!btn) return;
      removePlayer(btn.dataset.team, parseInt(btn.dataset.index, 10));
    });
    // Drag-to-reorder. The reducer (reorderPlayer) calls notify() — which
    // triggers renderGame on the (hidden) game screen — but renderRoster is
    // not state-subscribed, so we re-render it here. saveState() is reached
    // via renderGame, but we call it explicitly to match addPlayer/removePlayer.
    attachDragReorder(list, {
      itemSelector: 'li.roster-item',
      onReorder: ({ team: t }) => { renderRoster(t); saveState(); },
    });
  }
}
