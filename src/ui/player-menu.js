// Per-player context menu on the game screen's roster rows. Opens on
// right-click anywhere on a .player-row (long-press on touch) or on the
// row's small "⋯" button; the row's own +10 stays the one-click primary.
// Items:
//   - Sub out / Sub in (from the current question)  → state.js subOut/subIn
//   - +/- points…  → the scoreboard's custom-award panel, player preselected
//   - Clear this question's points (only when this player holds the answer)
//
// One menu element lives on <body>; every open re-renders it for the
// target player and positions it at the pointer, clamped to the viewport.
// It closes on any click elsewhere, Esc, scroll/resize, or a re-render of
// the game (state changed under it).

import { state, subOut, subIn, clearPlayerPoints } from '../state.js';
import { escapeHtml } from '../util/escape.js';
import { isBenched } from '../util/participation.js';
import { populateCustomAward } from './dev-tools.js';

const MENU_ID = 'player-menu';
let menuEl = null;
let target = null; // { team, index } while open

function ensureMenu() {
  if (menuEl) return menuEl;
  menuEl = document.createElement('div');
  menuEl.id = MENU_ID;
  menuEl.className = 'ctx-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.hidden = true;
  document.body.appendChild(menuEl);
  // The menu handles its own clicks — its buttons use data-menu, not
  // data-action, so main.js's global dispatcher never sees them.
  menuEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-menu]');
    if (!btn || !target) return;
    const { team, index } = target;
    const action = btn.dataset.menu;
    closePlayerMenu();
    if (action === 'sub-out') subOut(team, index);
    else if (action === 'sub-in') subIn(team, index);
    else if (action === 'clear-points') clearPlayerPoints(team, index);
    else if (action === 'custom-award') openCustomAwardFor(team, index);
  });
  // Dismissal: outside click (capture, so a click that opens something
  // else still closes us), Esc, scroll, resize.
  document.addEventListener('pointerdown', (e) => {
    if (menuEl.hidden) return;
    if (!menuEl.contains(e.target)) closePlayerMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menuEl.hidden) { e.stopPropagation(); closePlayerMenu(); }
  }, true);
  window.addEventListener('scroll', closePlayerMenu, true);
  window.addEventListener('resize', closePlayerMenu);
  return menuEl;
}

// Preselect the player in the scoreboard's "+/- Points" panel and open it.
// populateCustomAward runs synchronously here (the panel's own toggle
// handler re-runs it later and keeps the selection).
function openCustomAwardFor(team, index) {
  const details = document.getElementById('custom-award');
  if (!details) return;
  populateCustomAward();
  const sel = document.getElementById('dt-player');
  if (sel) sel.value = `${team}:${index}`;
  details.open = true;
  const pts = document.getElementById('dt-points');
  if (pts) pts.focus();
}

function heldAnswerPoints(team, index) {
  const h = state.history.find((e) => e.question === state.currentQuestion && e.team === team
    && e.playerIndex === index && !e.isStreak && !e.isCustom);
  return h ? h.points : null;
}

export function openPlayerMenu(team, index, { x, y }) {
  const teamObj = team === 'a' ? state.teamA : state.teamB;
  const p = teamObj.players[index];
  if (!p) return;
  const el = ensureMenu();
  target = { team, index };
  const q = state.questions[state.currentQuestion];
  const qNum = q ? q.num : state.currentQuestion + 1;
  const benched = isBenched(p);
  const held = heldAnswerPoints(team, index);
  const items = [];
  items.push(benched
    ? `<button data-menu="sub-in" role="menuitem">Sub in <span class="ctx-menu-hint">from Q${qNum}</span></button>`
    : `<button data-menu="sub-out" role="menuitem">Sub out <span class="ctx-menu-hint">from Q${qNum}</span></button>`);
  if (held != null) {
    items.push(`<button data-menu="clear-points" role="menuitem">Clear this question's +${held}</button>`);
  }
  items.push(`<button data-menu="custom-award" role="menuitem">+/- points…</button>`);
  el.innerHTML = `<div class="ctx-menu-title">${escapeHtml(p.name)}${benched ? ' <span class="ctx-menu-hint">(subbed out)</span>' : ''}</div>${items.join('')}`;
  el.hidden = false;
  // Position after render so we can clamp by the real size.
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, vw - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, vh - r.height - 4))}px`;
  const first = el.querySelector('button');
  if (first) first.focus({ preventScroll: true });
}

export function closePlayerMenu() {
  if (!menuEl || menuEl.hidden) return;
  menuEl.hidden = true;
  target = null;
}

export function isPlayerMenuOpen() {
  return !!menuEl && !menuEl.hidden;
}

// Wire a player panel: right-click on a row, or click on its ⋯ button.
export function attachPlayerMenu(panel) {
  panel.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.player-row');
    if (!row) return;
    e.preventDefault();
    openPlayerMenu(row.dataset.team, parseInt(row.dataset.index, 10), { x: e.clientX, y: e.clientY });
  });
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action="player-menu"]');
    if (!btn) return;
    const row = btn.closest('.player-row');
    const r = btn.getBoundingClientRect();
    openPlayerMenu(row.dataset.team, parseInt(row.dataset.index, 10), { x: r.left, y: r.bottom + 2 });
  });
}
