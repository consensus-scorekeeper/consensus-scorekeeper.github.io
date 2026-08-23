// The shared scoreboard snapshot (ui/scoreboard-popout.js) — rendered by
// the pop-out window AND pushed to phone-buzzer rooms. Guards the shape
// both consumers rely on, and the streak no-leak rule.

import { describe, it, expect, beforeEach } from 'vitest';
import { state, addPoints, subOut, subIn } from '../src/state.js';
import { rebuildStreakGroups } from '../src/game/streaks.js';
import { getScoreboardSnapshot } from '../src/ui/scoreboard-popout.js';
import { resetState, makeQ } from './helpers.js';

beforeEach(() => {
  resetState();
  state.teamA = { name: 'Alphas', score: 0, players: [{ name: 'Kim', points: 0 }] };
  state.teamB = { name: 'Bravos', score: 0, players: [{ name: 'Pat', points: 0 }] };
  state.questions = [];
  for (let n = 1; n <= 6; n++) state.questions.push(makeQ(n, { category: 'Set of 6: Rivers', posInCategory: n }));
  state.hasQuestions = true;
});

describe('getScoreboardSnapshot', () => {
  it('carries per-player points and team totals', () => {
    addPoints('a', 0, 10);
    const s = getScoreboardSnapshot();
    expect(s.teamA.players).toEqual([{ name: 'Kim', points: 10, benched: false }]);
    expect(s.teamA.score).toBe(10);
    expect(s.teamB.players).toEqual([{ name: 'Pat', points: 0, benched: false }]);
  });

  it('reports who answered the CURRENT question only', () => {
    expect(getScoreboardSnapshot().answered).toBeNull();
    addPoints('a', 0, 10); // auto-advance -> new current question unanswered
    expect(getScoreboardSnapshot().answered).toBeNull();
    state.currentQuestion = 0; // back on the answered one
    expect(getScoreboardSnapshot().answered).toMatchObject({ name: 'Kim', teamLetter: 'a', points: 10 });
  });

  it('hides the position counter on streaks (no part-count leak)', () => {
    expect(getScoreboardSnapshot().posNum).toBe(1);
    state.questions[2] = makeQ(3, { category: 'Streak: Capitals', posInCategory: 3, streakRange: { start: 3, end: 5 } });
    rebuildStreakGroups();
    state.currentQuestion = 2;
    const s = getScoreboardSnapshot();
    expect(s.posNum).toBeNull();
    expect(s.posTotal).toBeNull();
  });

  it('exposes jailbreak lock indices only on jailbreak questions', () => {
    expect(getScoreboardSnapshot().jailbreak).toBeNull();
    state.questions[0] = makeQ(1, { category: 'Jailbreak' });
    state.jailbreakLocked = { a: [0], b: [] };
    expect(getScoreboardSnapshot().jailbreak).toEqual({ lockedA: [0], lockedB: [] });
  });
});

describe('getScoreboardSnapshot — substitutions', () => {
  it('flags benched players so the popout and phones can mute them', () => {
    subOut('a', 0);
    expect(getScoreboardSnapshot().teamA.players[0]).toEqual({ name: 'Kim', points: 0, benched: true });
    subIn('a', 0); // same slot → cancelled
    expect(getScoreboardSnapshot().teamA.players[0].benched).toBe(false);
  });
});
