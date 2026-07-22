// Pure room decision logic (src/game/room-logic.js): the arm lifecycle,
// phone-name -> roster matching, and the past-questions (qlog) spoiler
// rules — exercised through the real reducers.

import { describe, it, expect, beforeEach } from 'vitest';
import { state, addPoints, undoLast, clearCurrentQuestion, reorderPlayer } from '../src/state.js';
import { rebuildStreakGroups } from '../src/game/streaks.js';
import {
  computeDesiredArmed, matchNameToRoster, buildQlog, isSpectatorName,
} from '../src/game/room-logic.js';
import { resetState, makeQ } from './helpers.js';

const ROOM = () => ({ active: true, hold: false, preselect: null });

function setupGame(nQuestions = 5) {
  state.teamA = { name: 'Alphas', score: 0, players: [{ name: 'Kim Lee', points: 0 }, { name: 'Sam', points: 0 }] };
  state.teamB = { name: 'Bravos', score: 0, players: [{ name: 'Pat', points: 0 }, { name: 'Kai', points: 0 }] };
  state.questions = [];
  for (let n = 1; n <= nQuestions; n++) state.questions.push(makeQ(n));
  state.hasQuestions = true;
}

beforeEach(() => { resetState(); setupGame(); });

describe('computeDesiredArmed', () => {
  it('arms a normal unanswered question', () => {
    expect(computeDesiredArmed(state, ROOM())).toBe(true);
  });

  it('disarms with no room, on hold, or while a preselect is pending', () => {
    expect(computeDesiredArmed(state, null)).toBe(false);
    expect(computeDesiredArmed(state, { ...ROOM(), hold: true })).toBe(false);
    expect(computeDesiredArmed(state, { ...ROOM(), preselect: { joinName: 'Kim Lee' } })).toBe(false);
  });

  it('award auto-advances to an unanswered slot (still armed); navigating back to the answered slot disarms', () => {
    addPoints('a', 0, 10);
    expect(state.currentQuestion).toBe(1);
    expect(computeDesiredArmed(state, ROOM())).toBe(true);
    state.currentQuestion = 0;
    expect(computeDesiredArmed(state, ROOM())).toBe(false);
  });

  it('undo re-opens the undone question', () => {
    addPoints('a', 0, 10);
    undoLast();
    expect(state.currentQuestion).toBe(0);
    expect(computeDesiredArmed(state, ROOM())).toBe(true);
  });

  it('clearing the current question re-arms it', () => {
    addPoints('a', 0, 10);
    state.currentQuestion = 0;
    clearCurrentQuestion();
    expect(computeDesiredArmed(state, ROOM())).toBe(true);
  });

  it('streak slots stay armed even after scoring (both teams keep going)', () => {
    state.questions[2] = makeQ(3, { category: 'Streak: Capitals', streakRange: { start: 3, end: 5 } });
    rebuildStreakGroups();
    state.currentQuestion = 2;
    expect(computeDesiredArmed(state, ROOM())).toBe(true);
    addPoints('a', 0, 5); // forced +5, no auto-advance
    expect(state.currentQuestion).toBe(2);
    expect(computeDesiredArmed(state, ROOM())).toBe(true);
    addPoints('b', 1, 5);
    expect(computeDesiredArmed(state, ROOM())).toBe(true);
  });

  it('disarms on missing and empty placeholder slots', () => {
    state.questions[0] = makeQ(1, { isMissing: true, question: '' });
    expect(computeDesiredArmed(state, ROOM())).toBe(false);
    state.questions[0] = makeQ(1, { question: '' });
    expect(computeDesiredArmed(state, ROOM())).toBe(false);
    state.questions = [];
    state.currentQuestion = 0;
    expect(computeDesiredArmed(state, ROOM())).toBe(false);
  });
});

describe('matchNameToRoster', () => {
  it('matches exactly, case- and whitespace-insensitively', () => {
    expect(matchNameToRoster('kim  lee', state)).toEqual({ team: 'a', playerIndex: 0, playerName: 'Kim Lee' });
    expect(matchNameToRoster(' PAT ', state)).toEqual({ team: 'b', playerIndex: 0, playerName: 'Pat' });
  });

  it('matches a unique prefix in either direction', () => {
    expect(matchNameToRoster('kim', state)).toEqual({ team: 'a', playerIndex: 0, playerName: 'Kim Lee' });
    expect(matchNameToRoster('Sammy', state)).toEqual({ team: 'a', playerIndex: 1, playerName: 'Sam' });
  });

  it('returns null on ambiguity or no match', () => {
    state.teamB.players.push({ name: 'Kim Park', points: 0 });
    expect(matchNameToRoster('kim', state)).toBeNull();
    expect(matchNameToRoster('Quinn', state)).toBeNull();
    expect(matchNameToRoster('', state)).toBeNull();
  });

  it('honors the explicit nameMap first and survives drag-reorder (mapping is by name)', () => {
    const nameMap = { phone7: 'Kai' };
    expect(matchNameToRoster('phone7', state, nameMap)).toEqual({ team: 'b', playerIndex: 1, playerName: 'Kai' });
    reorderPlayer('b', 1, 0);
    expect(matchNameToRoster('phone7', state, nameMap)).toEqual({ team: 'b', playerIndex: 0, playerName: 'Kai' });
  });

  it('never prefix-collapses onto a roster player who is a different connected joiner', () => {
    state.teamA.players.push({ name: 'Hansen Jin', points: 0 });
    state.room.connected = ['Hansen', 'Hansen Jin'];
    expect(matchNameToRoster('Hansen', state)).toBeNull();
    expect(matchNameToRoster('Hansen Jin', state)).toEqual({ team: 'a', playerIndex: 2, playerName: 'Hansen Jin' });
  });

  it('still prefix-matches when the full-named player has no phone of their own', () => {
    state.teamA.players.push({ name: 'Hansen Jin', points: 0 });
    state.room.connected = ['Hansen'];
    expect(matchNameToRoster('Hansen', state)).toEqual({ team: 'a', playerIndex: 2, playerName: 'Hansen Jin' });
  });

  it('never prefix-claims a roster player another join name is explicitly assigned to', () => {
    state.teamA.players.push({ name: 'Hansen Jin', points: 0 });
    expect(matchNameToRoster('Hansen', state, { phone3: 'Hansen Jin' })).toBeNull();
  });

  it('a null nameMap pin blocks prefix guessing but not an exact match', () => {
    state.teamA.players.push({ name: 'Hansen Jin', points: 0 });
    expect(matchNameToRoster('Hansen', state, { Hansen: null })).toBeNull();
    state.teamB.players.push({ name: 'Hansen', points: 0 });
    expect(matchNameToRoster('Hansen', state, { Hansen: null })).toEqual({ team: 'b', playerIndex: 2, playerName: 'Hansen' });
  });
});

describe('buildQlog', () => {
  it('includes answered questions that are no longer current, with a scorer summary', () => {
    addPoints('a', 0, 10); // Q1 answered, advance to Q2
    const log = buildQlog(state);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ label: 'Q1', question: 'Q1?', answerHtml: 'A1', summary: 'Kim Lee +10 (Alphas)' });
  });

  it('never leaks the current question, even when it is answered (re-adjudication)', () => {
    addPoints('a', 0, 10);
    state.currentQuestion = 0; // moderator jumps back to the answered Q1
    expect(buildQlog(state)).toHaveLength(0);
  });

  it('excludes unanswered questions and drops entries on undo', () => {
    state.currentQuestion = 2; // Q1, Q2 passed without scoring
    expect(buildQlog(state)).toHaveLength(0);
    addPoints('a', 1, 10); // Q3 answered, advance to Q4
    expect(buildQlog(state)).toHaveLength(1);
    undoLast();
    expect(buildQlog(state)).toHaveLength(0);
  });

  it('holds back a streak group until the moderator moves past it, then summarizes both teams', () => {
    state.questions[2] = makeQ(3, { category: 'Streak: Capitals', streakRange: { start: 3, end: 5 } });
    rebuildStreakGroups();
    state.currentQuestion = 2;
    addPoints('a', 0, 5);
    addPoints('a', 0, 5);
    addPoints('b', 0, 5);
    expect(buildQlog(state)).toHaveLength(0); // still inside the group
    state.questions.push(makeQ(6));
    state.currentQuestion = 5; // moved past the group
    expect(buildQlog(state)).toHaveLength(1);
    const entry = buildQlog(state)[0];
    expect(entry.label).toBe('Q3–5');
    expect(entry.summary).toBe('Kim Lee +10 (Alphas) · Pat +5 (Bravos)');
  });

  it('omits streak groups the moderator passed without any scoring', () => {
    state.questions[2] = makeQ(3, { category: 'Streak: Capitals', streakRange: { start: 3, end: 5 } });
    rebuildStreakGroups();
    state.questions.push(makeQ(6));
    state.currentQuestion = 5;
    expect(buildQlog(state)).toHaveLength(0);
  });

  it('escapes plain answers when no answerHtml exists', () => {
    state.questions[0] = makeQ(1, { answerHtml: null, answer: 'a < b' });
    addPoints('a', 0, 10);
    expect(buildQlog(state)[0].answerHtml).toBe('a &lt; b');
  });
});

describe('isSpectatorName', () => {
  it('flags the ~watch prefix only', () => {
    expect(isSpectatorName('~watch·x7')).toBe(true);
    expect(isSpectatorName('Kim')).toBe(false);
    expect(isSpectatorName('')).toBe(false);
  });
});
