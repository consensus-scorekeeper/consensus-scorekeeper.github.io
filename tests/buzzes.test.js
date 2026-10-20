// Correct-buzz counts (util/buzzes.js): counted from phone-buzzer
// verdicts — Space / the buzzed player's +10 = correct, Esc = wrong —
// through the real room host, reducers and CSV export.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { state } from '../src/main.js';
import { renderGame } from '../src/ui/game.js';
import { addPoints, undoLast, reorderPlayer, canUndo } from '../src/state.js';
import { rebuildStreakGroups } from '../src/game/streaks.js';
import { _setRoomForTest, handleRemoteBuzz, awardPreselect, dismissPreselect } from '../src/ui/room.js';
import { buzzCounts, formatBuzzCells } from '../src/util/buzzes.js';
import { buildResultsCsv } from '../src/util/csv.js';
import { resetState, makeQ } from './helpers.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const counts = (team, i) => {
  const p = (team === 'a' ? state.teamA : state.teamB).players[i];
  return buzzCounts(state.history, team, i, p);
};

function fakeRoom() {
  return { code: 'TEST', sent: [], send(m) { this.sent.push(m); }, close() {}, playerUrl() { return 'x'; } };
}

describe('pure helpers', () => {
  it('leaves the CSV cells blank for players without buzzes', () => {
    expect(formatBuzzCells({ correct: 3, wrong: 1 })).toEqual([3, 1]);
    expect(formatBuzzCells({ correct: 0, wrong: 0 })).toEqual(['', '']);
  });
});

describe('counting from buzzer verdicts', () => {
  beforeEach(() => {
    resetState();
    state.teamA = { name: 'Alphas', score: 0, players: [{ name: 'Kim', points: 0 }, { name: 'Sam', points: 0 }] };
    state.teamB = { name: 'Bravos', score: 0, players: [{ name: 'Pat', points: 0 }, { name: 'Kai', points: 0 }] };
    state.questions = [];
    for (let n = 1; n <= 6; n++) state.questions.push(makeQ(n));
    state.hasQuestions = true;
    document.getElementById('setup').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    _setRoomForTest(fakeRoom());
    renderGame();
  });
  afterEach(() => _setRoomForTest(null));

  it('Space counts a correct buzz, Esc a wrong one', async () => {
    handleRemoteBuzz('Pat');
    await tick();
    expect(document.getElementById('room-buzz-bar').textContent).toContain('Esc wrong');
    dismissPreselect();
    expect(counts('b', 0)).toEqual({ correct: 0, wrong: 1 });

    handleRemoteBuzz('Kim');
    await tick();
    awardPreselect();
    expect(counts('a', 0)).toEqual({ correct: 1, wrong: 0 });
    expect(document.querySelector('#panel-a .player-buzzes').textContent).toBe('1/1');
    expect(document.querySelector('#panel-b .player-buzzes').textContent).toBe('0/1');
  });

  it("the buzzed player's +10 counts; scoring someone else counts nothing", async () => {
    handleRemoteBuzz('Kim');
    await tick();
    addPoints('a', 0, 10);
    expect(counts('a', 0).correct).toBe(1);

    handleRemoteBuzz('Pat');
    await tick();
    addPoints('b', 1, 10); // moderator gave it to Kai instead
    expect(counts('b', 0)).toEqual({ correct: 0, wrong: 0 });
    expect(counts('b', 1)).toEqual({ correct: 0, wrong: 0 });
  });

  it('number-key scoring without a buzz leaves the row untouched', () => {
    addPoints('a', 1, 10);
    expect(counts('a', 1)).toEqual({ correct: 0, wrong: 0 });
    expect(document.querySelector('#panel-a .player-buzzes')).toBeNull();
  });

  it('an unmatched buzz dismissed with Esc is not counted', async () => {
    handleRemoteBuzz('Stranger');
    await tick();
    dismissPreselect();
    for (const t of ['a', 'b']) for (const i of [0, 1]) expect(counts(t, i).wrong).toBe(0);
  });

  it('streaks are left out', async () => {
    state.questions[0] = makeQ(1, { streakRange: { start: 1, end: 2 } });
    state.questions[1] = makeQ(2, { question: '' });
    state.questions[0].isStreak = true; state.questions[0].streakGroupStart = 0;
    state.questions[1].isStreak = true; state.questions[1].streakGroupStart = 0;
    rebuildStreakGroups();
    renderGame();
    handleRemoteBuzz('Kim');
    await tick();
    expect(document.getElementById('room-buzz-bar').textContent).toContain('Esc dismisses');
    dismissPreselect();
    handleRemoteBuzz('Kim');
    await tick();
    awardPreselect();
    expect(counts('a', 0)).toEqual({ correct: 0, wrong: 0 });
  });

  it('Ctrl+Z takes back the newest action, wrong buzz or score', async () => {
    handleRemoteBuzz('Kim');
    await tick();
    awardPreselect();               // Q1: Kim correct
    handleRemoteBuzz('Pat');
    await tick();
    dismissPreselect();             // Q2: Pat wrong
    handleRemoteBuzz('Sam');
    await tick();
    awardPreselect();               // Q2: Sam correct

    undoLast();                     // Sam's points
    expect(counts('a', 1).correct).toBe(0);
    expect(counts('b', 0).wrong).toBe(1);
    undoLast();                     // Pat's wrong buzz
    expect(counts('b', 0).wrong).toBe(0);
    expect(counts('a', 0).correct).toBe(1);
    undoLast();                     // Kim's points
    expect(counts('a', 0).correct).toBe(0);
    expect(canUndo()).toBe(false);
  });

  it('a lone wrong buzz enables Undo', async () => {
    handleRemoteBuzz('Pat');
    await tick();
    dismissPreselect();
    expect(canUndo()).toBe(true);
    expect(document.getElementById('undo-btn').disabled).toBe(false);
  });

  it('counts follow the player through drag-reorder', async () => {
    handleRemoteBuzz('Kim');
    await tick();
    awardPreselect();
    handleRemoteBuzz('Kim');
    await tick();
    dismissPreselect();
    reorderPlayer('a', 0, 1);
    expect(state.teamA.players[1].name).toBe('Kim');
    expect(counts('a', 1)).toEqual({ correct: 1, wrong: 1 });
    expect(counts('a', 0)).toEqual({ correct: 0, wrong: 0 });
  });

  it('exports Correct/Wrong, blank for players without buzzes', async () => {
    handleRemoteBuzz('Kim');
    await tick();
    awardPreselect();
    handleRemoteBuzz('Pat');
    await tick();
    dismissPreselect();
    const csv = buildResultsCsv(state);
    const lines = csv.split('\r\n');
    const i = lines.indexOf('Player,Team,Points,Played,Correct,Wrong');
    expect(lines.slice(i + 1, i + 5)).toEqual(['Kim,Alphas,10,1,1,0', 'Sam,Alphas,0,1,,', 'Pat,Bravos,0,1,0,1', 'Kai,Bravos,0,1,,']);
  });
});
