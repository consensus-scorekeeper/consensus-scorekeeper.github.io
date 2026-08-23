import { describe, it, expect, beforeEach } from 'vitest';
import { state, addPoints, undoLast, clearCurrentQuestion, subOut, subIn, reorderPlayer } from '../src/main.js';
import { resetState, makeQ } from './helpers.js';

beforeEach(() => {
  resetState();
  state.teamA = {
    name: 'Alphas',
    players: [{ name: 'A1', points: 0 }, { name: 'A2', points: 0 }],
    score: 0,
  };
  state.teamB = {
    name: 'Bravos',
    players: [{ name: 'B1', points: 0 }],
    score: 0,
  };
  state.questions = [makeQ(1), makeQ(2), makeQ(3)];
  state.hasQuestions = true;
});

describe('addPoints — non-streak question', () => {
  it('adds points to player and team, marks question answered, advances cursor', () => {
    state.currentQuestion = 0;
    addPoints('a', 0, 10);
    expect(state.teamA.players[0].points).toBe(10);
    expect(state.teamA.score).toBe(10);
    expect(state.answeredQuestions.has(0)).toBe(true);
    expect(state.currentQuestion).toBe(1);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ team: 'a', playerIndex: 0, points: 10, question: 0 });
  });

  it('does not advance past the last question', () => {
    state.currentQuestion = 2;
    addPoints('a', 0, 10);
    expect(state.currentQuestion).toBe(2);
  });

  it('reassigns points if a different team buzzes after a wrong answer', () => {
    state.currentQuestion = 0;
    addPoints('a', 0, 10);
    state.currentQuestion = 0; // simulate the moderator going back
    addPoints('b', 0, 10);
    // Team A's points removed, Team B awarded
    expect(state.teamA.players[0].points).toBe(0);
    expect(state.teamA.score).toBe(0);
    expect(state.teamB.players[0].points).toBe(10);
    expect(state.teamB.score).toBe(10);
  });
});

describe('addPoints — streak question', () => {
  it('forces +5 and does NOT advance the cursor', () => {
    state.questions = [
      makeQ(1, { isStreak: true, streakGroupStart: 0, category: 'Streak: X' }),
      makeQ(2),
    ];
    state.streakGroups = { 0: { start: 0, end: 0, members: [0], category: 'Streak: X', sourceQuestion: state.questions[0] } };
    state.currentQuestion = 0;

    addPoints('a', 0, 10); // points arg is ignored on streak — forces 5
    expect(state.teamA.players[0].points).toBe(5);
    expect(state.teamA.score).toBe(5);
    expect(state.currentQuestion).toBe(0); // no advance
    expect(state.streakScoring[0]).toBeDefined();
    expect(state.streakScoring[0].a.totalPoints).toBe(5);
  });

  it('accumulates streak points across multiple buzzes from the same player', () => {
    state.questions = [makeQ(1, { isStreak: true, streakGroupStart: 0, category: 'Streak: X' })];
    state.streakGroups = { 0: { start: 0, end: 0, members: [0], category: 'Streak: X', sourceQuestion: state.questions[0] } };
    state.currentQuestion = 0;
    addPoints('a', 0, 10);
    addPoints('a', 0, 10);
    addPoints('a', 0, 10);
    expect(state.teamA.players[0].points).toBe(15);
    expect(state.streakScoring[0].a.totalPoints).toBe(15);
  });

  it('allows both teams to score on the same streak (separate buckets)', () => {
    state.questions = [makeQ(1, { isStreak: true, streakGroupStart: 0, category: 'Streak: X' })];
    state.streakGroups = { 0: { start: 0, end: 0, members: [0], category: 'Streak: X', sourceQuestion: state.questions[0] } };
    state.currentQuestion = 0;
    addPoints('a', 0, 10);
    addPoints('b', 0, 10);
    expect(state.teamA.score).toBe(5);
    expect(state.teamB.score).toBe(5);
    expect(state.streakScoring[0].a).toBeDefined();
    expect(state.streakScoring[0].b).toBeDefined();
  });

  it('switching to a different player on the same team wipes that team\'s streak total', () => {
    state.questions = [makeQ(1, { isStreak: true, streakGroupStart: 0, category: 'Streak: X' })];
    state.streakGroups = { 0: { start: 0, end: 0, members: [0], category: 'Streak: X', sourceQuestion: state.questions[0] } };
    state.currentQuestion = 0;
    addPoints('a', 0, 10);
    addPoints('a', 0, 10); // 10 total on player 0
    addPoints('a', 1, 10); // misclick correction → wipe player 0, start player 1
    expect(state.teamA.players[0].points).toBe(0);
    expect(state.teamA.players[1].points).toBe(5);
    expect(state.teamA.score).toBe(5);
    expect(state.streakScoring[0].a.playerIndex).toBe(1);
    expect(state.streakScoring[0].a.totalPoints).toBe(5);
  });
});

describe('undoLast', () => {
  it('reverses the most recent score and unmarks the question if no entries remain', () => {
    state.currentQuestion = 0;
    addPoints('a', 0, 10); // currentQuestion advances to 1
    expect(state.teamA.score).toBe(10);
    expect(state.answeredQuestions.has(0)).toBe(true);
    undoLast();
    expect(state.teamA.score).toBe(0);
    expect(state.teamA.players[0].points).toBe(0);
    expect(state.history).toHaveLength(0);
    expect(state.answeredQuestions.has(0)).toBe(false);
  });
});

describe('clearCurrentQuestion', () => {
  it('removes the score awarded for the current question', () => {
    state.currentQuestion = 0;
    addPoints('a', 0, 10); // advances cursor; we'll go back manually
    state.currentQuestion = 0;
    clearCurrentQuestion();
    expect(state.teamA.score).toBe(0);
    expect(state.answeredQuestions.has(0)).toBe(false);
  });
});

describe('subOut / subIn (substitutions)', () => {
  it('subOut opens an interval at the current slot; subIn closes it at the current slot', () => {
    state.currentQuestion = 1;
    subOut('a', 0);
    expect(state.teamA.players[0].subs).toEqual([{ out: 1, in: null }]);
    state.currentQuestion = 2;
    subIn('a', 0);
    expect(state.teamA.players[0].subs).toEqual([{ out: 1, in: 2 }]);
  });

  it('is a no-op on a player already in that state, or on a bad index', () => {
    subIn('a', 0);
    expect(state.teamA.players[0].subs).toBeUndefined();
    subOut('a', 0);
    subOut('a', 0);
    expect(state.teamA.players[0].subs).toEqual([{ out: 0, in: null }]);
    expect(() => subOut('b', 9)).not.toThrow();
    expect(() => subIn('b', 9)).not.toThrow();
  });

  it('sub in at (or before) the slot they went out on cancels the sub outright', () => {
    state.currentQuestion = 2;
    subOut('b', 0);
    subIn('b', 0); // mis-click, same question
    expect(state.teamB.players[0].subs).toEqual([]);
    subOut('b', 0);
    state.currentQuestion = 1; // moderator navigated backwards
    subIn('b', 0);
    expect(state.teamB.players[0].subs).toEqual([]);
  });

  it('sub out again at the slot they came back in on reopens that interval (no overlap)', () => {
    state.currentQuestion = 0;
    subOut('a', 1);
    state.currentQuestion = 2;
    subIn('a', 1);
    subOut('a', 1); // changed their mind on the same question
    expect(state.teamA.players[1].subs).toEqual([{ out: 0, in: null }]);
  });

  it('intervals survive drag-reorder because they live on the player', () => {
    state.currentQuestion = 1;
    subOut('a', 1);
    reorderPlayer('a', 1, 0);
    expect(state.teamA.players[0].name).toBe('A2');
    expect(state.teamA.players[0].subs).toEqual([{ out: 1, in: null }]);
    expect(state.teamA.players[1].subs).toBeUndefined();
  });
});
