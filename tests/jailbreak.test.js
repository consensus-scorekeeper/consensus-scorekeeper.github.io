// Jailbreak lockouts (game/jailbreak.js) — rebuilt from history each
// render. The substitutions cases are the reason Sub out exists: a
// 5-person roster with one player on the bench must cycle after the 4
// available players have buzzed, instead of staying locked forever.

import { describe, it, expect, beforeEach } from 'vitest';
import { state, addPoints, rebuildJailbreakLocks, subOut, subIn, undoLast } from '../src/main.js';
import { resetState, makeQ } from './helpers.js';

const JB = { category: 'Jailbreak: Science' };

beforeEach(() => {
  resetState();
  state.teamA = {
    name: 'Alphas',
    players: ['A1', 'A2', 'A3', 'A4', 'A5'].map((name) => ({ name, points: 0 })),
    score: 0,
  };
  state.teamB = { name: 'Bravos', players: [{ name: 'B1', points: 0 }, { name: 'B2', points: 0 }], score: 0 };
  state.questions = Array.from({ length: 12 }, (_, i) => makeQ(i + 1, JB));
  state.hasQuestions = true;
  state.currentQuestion = 0;
});

// Score for team A's player i on the current question (auto-advances).
const buzz = (i, team = 'a') => addPoints(team, i, 10);

describe('rebuildJailbreakLocks — full roster', () => {
  it('locks each player after they score and resets once the whole team has', () => {
    buzz(0); buzz(1); buzz(2); buzz(3);
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked.a).toEqual([0, 1, 2, 3]);
    buzz(4);
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked.a).toEqual([]);
  });

  it('keeps per-team locks independent', () => {
    buzz(0); buzz(0, 'b');
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked).toEqual({ a: [0], b: [0] });
  });
});

describe('rebuildJailbreakLocks — substitutions', () => {
  it('THE BUG: 5 rostered, 1 subbed out → round completes after the 4 available buzz', () => {
    subOut('a', 4); // A5 sits out from Q1
    buzz(0); buzz(1); buzz(2);
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked.a).toEqual([0, 1, 2]);
    buzz(3);
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked.a).toEqual([]); // not stuck waiting on A5
  });

  it('a player who buzzed and was THEN benched does not hold the round open', () => {
    buzz(4);             // A5 buzzes (Q1), then leaves
    subOut('a', 4);      // out from Q2 on
    buzz(0); buzz(1); buzz(2);
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked.a).toEqual([4, 0, 1, 2]);
    buzz(3);             // every AVAILABLE player has now buzzed
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked.a).toEqual([]);
  });

  it('subbing out the last unlocked player completes the round with no buzz at all', () => {
    buzz(0); buzz(1); buzz(2); buzz(3);
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked.a).toEqual([0, 1, 2, 3]);
    subOut('a', 4);      // A5 leaves before ever buzzing
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked.a).toEqual([]);
  });

  it('a player subbed IN mid-round must buzz before the round resets', () => {
    subOut('a', 4);
    buzz(0); buzz(1);
    subIn('a', 4);       // A5 arrives at Q3
    buzz(2); buzz(3);
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked.a).toEqual([0, 1, 2, 3]); // A5 still owes a buzz
    buzz(4);
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked.a).toEqual([]);
  });

  it('replays old rounds with the bench as it was THEN, not now', () => {
    // Round 1 with all five present: everyone buzzes → reset.
    buzz(0); buzz(1); buzz(2); buzz(3); buzz(4);
    // A5 then goes out; round 2 starts with four available.
    subOut('a', 4);
    buzz(0); buzz(1);
    rebuildJailbreakLocks();
    // If round 1 were replayed against today's 4-player bench it would
    // reset after A4 and leave a phantom [4] lock carrying into round 2.
    expect(state.jailbreakLocked.a).toEqual([0, 1]);
  });

  it('undo stays consistent (derived from history, so it just falls out)', () => {
    subOut('a', 4);
    buzz(0); buzz(1); buzz(2); buzz(3);
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked.a).toEqual([]);
    undoLast(); // A4's buzz taken back → round open again
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked.a).toEqual([0, 1, 2]);
  });

  it('a fully benched team never resets (nobody is available to complete a round)', () => {
    subOut('b', 0); subOut('b', 1);
    buzz(0, 'b'); // moderator override via the panel is still possible
    rebuildJailbreakLocks();
    expect(state.jailbreakLocked.b).toEqual([0]);
  });
});
