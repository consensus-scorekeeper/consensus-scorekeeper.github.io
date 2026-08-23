// The player-row context menu (ui/player-menu.js) on the game screen,
// driven through main.js's real wiring against the injected index.html:
// right-click / ⋯ open it, Sub out / Sub in / +- points / clear entries,
// the benched row losing its scoring button, and the keybind guard.

import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../src/main.js';
import { renderGame } from '../src/ui/game.js';
import { resetState, makeQ } from './helpers.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const panelA = () => document.getElementById('panel-a');
const rows = () => [...panelA().querySelectorAll('.player-row')];
const menu = () => document.getElementById('player-menu');
const menuItems = () => [...menu().querySelectorAll('button[data-menu]')].map((b) => b.dataset.menu);
const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const rightClick = (el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
const pick = async (action) => { menu().querySelector(`button[data-menu="${action}"]`).click(); await tick(); };

beforeEach(() => {
  resetState();
  state.teamA = { name: 'Alphas', players: [{ name: 'Kim', points: 0 }, { name: 'Sam', points: 0 }], score: 0 };
  state.teamB = { name: 'Bravos', players: [{ name: 'Pat', points: 0 }], score: 0 };
  state.questions = Array.from({ length: 10 }, (_, i) => makeQ(i + 1));
  state.hasQuestions = true;
  state.currentQuestion = 0;
  document.getElementById('setup').style.display = 'none';
  document.getElementById('game').style.display = 'block';
  renderGame();
});

describe('opening the menu', () => {
  it('right-click on a row opens it for that player; no big sub button on the row', () => {
    for (const row of rows()) {
      expect(row.querySelector('[data-action="add-points"]')).not.toBeNull();
      expect(row.querySelector('[data-action="player-menu"]')).not.toBeNull();
      expect(row.querySelector('[data-action="sub-out"]')).toBeNull();
    }
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
    rows()[1].dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // browser menu suppressed
    expect(menu().hidden).toBe(false);
    expect(menu().querySelector('.ctx-menu-title').textContent).toBe('Sam');
    expect(menuItems()).toEqual(['sub-out', 'custom-award']);
  });

  it('the ⋯ button opens the same menu (touch / discoverability path)', () => {
    rows()[0].querySelector('[data-action="player-menu"]').click();
    expect(menu().hidden).toBe(false);
    expect(menu().querySelector('.ctx-menu-title').textContent).toBe('Kim');
  });

  it('closes on Escape, on an outside pointerdown, and on re-render', () => {
    rightClick(rows()[0]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu().hidden).toBe(true);
    rightClick(rows()[0]);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(menu().hidden).toBe(true);
    rightClick(rows()[0]);
    renderGame();
    expect(menu().hidden).toBe(true);
  });
});

describe('Sub out / Sub in via the menu', () => {
  it('Sub out benches the row: muted, no +10, "out since" tag; menu then offers Sub in', async () => {
    state.currentQuestion = 3; // on Q4
    renderGame();
    rightClick(rows()[0]);
    expect(menu().querySelector('[data-menu="sub-out"]').textContent).toContain('from Q4');
    await pick('sub-out');
    const kim = rows()[0];
    expect(state.teamA.players[0].subs).toEqual([{ out: 3, in: null }]);
    expect(kim.classList.contains('player-row-benched')).toBe(true);
    expect(kim.querySelector('[data-action="add-points"]')).toBeNull();
    expect(kim.querySelector('.player-sub-tag').textContent).toBe('out since Q4');
    expect(rows()[1].querySelector('[data-action="add-points"]')).not.toBeNull(); // teammate untouched
    rightClick(rows()[0]);
    expect(menuItems()).toEqual(['sub-in', 'custom-award']);
  });

  it('Sub in at a later question closes the interval and restores the row', async () => {
    rightClick(rows()[0]);
    await pick('sub-out');
    state.currentQuestion = 5;
    renderGame();
    rightClick(rows()[0]);
    await pick('sub-in');
    expect(state.teamA.players[0].subs).toEqual([{ out: 0, in: 5 }]);
    expect(rows()[0].classList.contains('player-row-benched')).toBe(false);
    expect(rows()[0].querySelector('[data-action="add-points"]')).not.toBeNull();
  });

  it('a benched player\'s number key is ignored (teammates\' keys still score)', async () => {
    rightClick(rows()[0]);
    await pick('sub-out');
    key('1'); // Kim — benched
    expect(state.teamA.players[0].points).toBe(0);
    expect(state.history).toHaveLength(0);
    key('2'); // Sam
    expect(state.teamA.players[1].points).toBe(10);
  });

  it('the jailbreak "locked" tag is not shown on a benched row', async () => {
    state.questions[0] = makeQ(1, { category: 'Jailbreak' });
    state.questions[1] = makeQ(2, { category: 'Jailbreak' });
    renderGame();
    rows()[0].querySelector('[data-action="add-points"]').click(); // Kim buzzes → locked
    await tick();
    expect(rows()[0].querySelector('.player-lock-tag:not(.player-sub-tag)')).not.toBeNull();
    rightClick(rows()[0]);
    await pick('sub-out');
    expect(rows()[0].querySelector('.player-lock-tag:not(.player-sub-tag)')).toBeNull();
    expect(rows()[0].querySelector('.player-sub-tag')).not.toBeNull();
  });
});

describe('other menu entries', () => {
  it('+/- points… opens the custom-award panel with this player preselected', async () => {
    rightClick(rows()[1]);
    await pick('custom-award');
    const details = document.getElementById('custom-award');
    expect(details.open).toBe(true);
    expect(document.getElementById('dt-player').value).toBe('a:1');
    expect(document.getElementById('dt-question').value).toBe('1');
    details.open = false;
  });

  it('offers "Clear this question\'s +10" only for the player who holds the answer, and it works', async () => {
    rows()[0].querySelector('[data-action="add-points"]').click(); // Kim scores Q1 → Q2
    await tick();
    state.currentQuestion = 0; // back on the answered question
    renderGame();
    rightClick(rows()[1]); // Sam: nothing to clear
    expect(menuItems()).toEqual(['sub-out', 'custom-award']);
    rightClick(rows()[0]); // Kim
    expect(menuItems()).toEqual(['sub-out', 'clear-points', 'custom-award']);
    expect(menu().querySelector('[data-menu="clear-points"]').textContent).toContain('+10');
    await pick('clear-points');
    expect(state.teamA.players[0].points).toBe(0);
    expect(state.answeredQuestions.has(0)).toBe(false);
  });
});
