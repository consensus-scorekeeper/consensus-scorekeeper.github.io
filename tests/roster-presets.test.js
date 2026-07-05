import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../src/main.js';
import { setTeamNameField, toggleRosterMode, getRosterMode } from '../src/ui/setup.js';
import { PLAYER_SUGGESTIONS, TOURNAMENTS, DEFAULT_TOURNAMENT } from '../src/ui/roster-presets.js';
import { resetState } from './helpers.js';

// Toggle into a known mode before each test. setupSetupScreen ran at main.js
// import time using whatever localStorage held; force preset mode here so
// the dropdown-specific assertions don't depend on test-execution order.
// (The custom default is fine for end-users but flips the team-name field
// to <input>, which several tests below assume is <select>.)
function ensurePresetMode() {
  if (getRosterMode() !== 'preset') toggleRosterMode();
}

beforeEach(() => {
  resetState();
  ensurePresetMode();
});

describe('TOURNAMENTS registry', () => {
  it('every tournament has the fields the hub + setup pages depend on', () => {
    // The slug doubles as the folder name under tournaments/, so it must
    // match the URL-safe pattern. statsPage is intentionally NOT a field
    // — links are derived from `<slug>/`.
    for (const t of TOURNAMENTS) {
      expect(t.name, t.slug).toBeTruthy();
      expect(t.slug, t.name).toBeTruthy();
      expect(t.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(Array.isArray(t.rosters), t.name).toBe(true);
      for (const r of t.rosters) {
        expect(r.name, `${t.name} roster`).toBeTruthy();
        expect(Array.isArray(r.players), `${t.name} → ${r.name}`).toBe(true);
        expect(r.players.length, `${t.name} → ${r.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('slugs are unique', () => {
    const slugs = TOURNAMENTS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

});

describe('team-name <select> presets', () => {
  it('is populated with every roster of the default tournament plus a placeholder', () => {
    const sel = document.getElementById('team-a-name');
    // setupSetupScreen() ran at main.js import time. First option is the
    // "— Pick a team —" placeholder; remaining options correspond 1:1 with
    // the rosters of whichever tournament is currently selected (default).
    const values = Array.from(sel.options).map((o) => o.value);
    expect(values[0]).toBe('');
    expect(values.slice(1)).toEqual(DEFAULT_TOURNAMENT.rosters.map((p) => p.name));
  });

  it('selecting a preset auto-populates name + players (change event)', () => {
    const sel = document.getElementById('team-a-name');
    sel.value = 'Wookiee';
    sel.dispatchEvent(new Event('change'));
    expect(state.teamA.name).toBe('Wookiee');
    expect(state.teamA.players.map((p) => p.name)).toEqual(['Danny Han', 'Denis Liu', 'Ethan Bosita']);
    // Each player starts with zero points.
    expect(state.teamA.players.every((p) => p.points === 0)).toBe(true);
  });

  it('selecting the placeholder clears the team', () => {
    const sel = document.getElementById('team-b-name');
    sel.value = 'Sarlacc';
    sel.dispatchEvent(new Event('change'));
    expect(state.teamB.players.length).toBeGreaterThan(0);
    sel.value = '';
    sel.dispatchEvent(new Event('change'));
    expect(state.teamB.name).toBe('');
    expect(state.teamB.players).toEqual([]);
  });

  it('Michał Gerasimiuk is on the Sarlacc roster and in the autocomplete list', () => {
    const sarlacc = DEFAULT_TOURNAMENT.rosters.find((p) => p.name === 'Sarlacc');
    expect(sarlacc.players).toContain('Michał Gerasimiuk');
    expect(PLAYER_SUGGESTIONS).toContain('Michał Gerasimiuk');
    const dl = document.getElementById('player-suggestions');
    const values = Array.from(dl.querySelectorAll('option')).map((o) => o.value);
    expect(values).toContain('Michał Gerasimiuk');
  });
});

describe('roster-mode toggle', () => {
  it('switches the team-name field from <select> to <input> and back', () => {
    expect(getRosterMode()).toBe('preset');
    expect(document.getElementById('team-a-name').tagName).toBe('SELECT');
    toggleRosterMode();
    expect(getRosterMode()).toBe('custom');
    expect(document.getElementById('team-a-name').tagName).toBe('INPUT');
    toggleRosterMode();
    expect(getRosterMode()).toBe('preset');
    expect(document.getElementById('team-a-name').tagName).toBe('SELECT');
  });

  it('typing in custom mode updates state.teamA.name', () => {
    toggleRosterMode();
    const el = document.getElementById('team-a-name');
    el.value = 'Phoenix';
    el.dispatchEvent(new Event('input'));
    expect(state.teamA.name).toBe('Phoenix');
    toggleRosterMode(); // back to preset for the next test
  });

  it('preserves the current team name when switching modes', () => {
    state.teamA.name = 'Wookiee';
    state.teamA.players = [{ name: 'Danny Han', points: 0 }];
    setTeamNameField('a', 'Wookiee');
    toggleRosterMode(); // -> custom
    expect(document.getElementById('team-a-name').value).toBe('Wookiee');
    toggleRosterMode(); // -> preset
    expect(document.getElementById('team-a-name').value).toBe('Wookiee');
  });

  it('the tournament-picker dropdown is shown only in preset mode', () => {
    const picker = document.getElementById('roster-tournament-picker');
    expect(picker).toBeTruthy();
    // We're in preset mode (set by ensurePresetMode in beforeEach).
    expect(picker.hidden).toBe(false);
    toggleRosterMode(); // -> custom
    expect(picker.hidden).toBe(true);
    toggleRosterMode(); // -> preset
    expect(picker.hidden).toBe(false);
  });
});

describe('setTeamNameField', () => {
  it('selects a matching preset option without injecting a duplicate', () => {
    setTeamNameField('a', 'Wookiee');
    const sel = document.getElementById('team-a-name');
    expect(sel.value).toBe('Wookiee');
    expect(sel.querySelectorAll('option[data-dynamic="true"]')).toHaveLength(0);
  });

  it('injects a one-off option for non-preset names (e.g. tutorial / legacy saves)', () => {
    setTeamNameField('a', 'Quizmasters');
    const sel = document.getElementById('team-a-name');
    expect(sel.value).toBe('Quizmasters');
    expect(sel.querySelectorAll('option[data-dynamic="true"]')).toHaveLength(1);
  });

  it('replaces a stale dynamic option rather than accumulating them', () => {
    setTeamNameField('a', 'Quizmasters');
    setTeamNameField('a', 'Trivia Titans');
    const sel = document.getElementById('team-a-name');
    expect(sel.value).toBe('Trivia Titans');
    expect(sel.querySelectorAll('option[data-dynamic="true"]')).toHaveLength(1);
  });
});
