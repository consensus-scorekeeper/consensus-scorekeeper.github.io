// Host-side room integration (src/ui/room.js) driven through the real
// render loop and reducers against a fake room handle: buzz -> preselect
// -> award -> re-arm message sequences, jailbreak silent re-arms,
// click-to-assign, and qlog push-on-change.

import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../src/main.js';
import { renderGame } from '../src/ui/game.js';
import { addPoints, undoLast } from '../src/state.js';
import { rebuildStreakGroups } from '../src/game/streaks.js';
import {
  _setRoomForTest, handleRemoteBuzz, handlePendingBuzz, awardPreselect,
  dismissPreselect, assignBuzzer, assignJoinerToTeam, toggleHold,
  unassignPhone,
} from '../src/ui/room.js';
import { resetState, makeQ } from './helpers.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeRoom() {
  return {
    code: 'TEST',
    sent: [],
    send(m) { this.sent.push(m); },
    close() { this.closed = true; },
    playerUrl() { return 'https://example.test/player.html?code=TEST'; },
    // helpers for assertions
    types() { return this.sent.map((m) => m.t); },
    last(t) { return [...this.sent].reverse().find((m) => m.t === t); },
    clear() { this.sent = []; },
  };
}

let fake;

beforeEach(() => {
  resetState();
  state.teamA = { name: 'Alphas', score: 0, players: [{ name: 'Kim Lee', points: 0 }, { name: 'Sam', points: 0 }] };
  state.teamB = { name: 'Bravos', score: 0, players: [{ name: 'Pat', points: 0 }, { name: 'Kai', points: 0 }] };
  state.questions = [];
  for (let n = 1; n <= 6; n++) state.questions.push(makeQ(n));
  state.hasQuestions = true;
  document.getElementById('setup').style.display = 'none';
  document.getElementById('game').style.display = 'block';
  fake = fakeRoom();
  _setRoomForTest(fake);
});

describe('syncRoom message flow', () => {
  it('pushes snapshot + arm on render of an open question', () => {
    renderGame();
    expect(fake.types()).toContain('state');
    expect(fake.types()).toContain('arm');
    const snap = fake.last('state').snapshot;
    expect(snap.teamA.players[0]).toEqual({ name: 'Kim Lee', points: 0 });
  });

  it('does not resend arm while nothing changes, and pushes qlog only on change', () => {
    renderGame();
    fake.clear();
    renderGame();
    expect(fake.types()).toEqual(['state']); // no arm repeat, no qlog repeat
    addPoints('a', 0, 10); // notify() -> renderGame -> syncRoom
    expect(fake.last('qlog').qlog).toHaveLength(1);
    expect(fake.last('qlog').qlog[0].summary).toBe('Kim Lee +10 (Alphas)');
  });

  it('holds and releases the buzzers via the hold toggle', async () => {
    renderGame();
    toggleHold();
    await tick();
    expect(fake.types().at(-1)).not.toBe('arm');
    expect(fake.last('disarm')).toBeTruthy();
    fake.clear();
    toggleHold();
    await tick();
    expect(fake.types()).toContain('arm');
  });
});

describe('pending buzz (first arrival, window open)', () => {
  it('shows the stop-reading cue instantly and hands off to the equalized winner', async () => {
    renderGame();
    handlePendingBuzz('Kim Lee');
    await tick();
    expect(state.room.pendingBuzz).toBe('Kim Lee');
    expect(document.getElementById('room-buzz-bar').textContent).toContain('Kim Lee');

    handleRemoteBuzz('Pat'); // equalized winner differs from first arrival
    await tick();
    expect(state.room.pendingBuzz).toBeNull();
    expect(state.room.preselect).toMatchObject({ team: 'b', playerName: 'Pat' });
  });

  it('ignores pending cues from spectators and while holding', async () => {
    renderGame();
    handlePendingBuzz('~watch·x1');
    expect(state.room.pendingBuzz).toBeNull();
    state.room.hold = true;
    handlePendingBuzz('Kim Lee');
    expect(state.room.pendingBuzz).toBeNull();
  });
});

describe('remote buzz -> preselect -> verdict', () => {
  it('matched buzz preselects, disarms; Space-award clears it, auto-advances, re-arms', async () => {
    renderGame();
    fake.clear();
    handleRemoteBuzz('kim lee');
    await tick();
    expect(state.room.preselect).toMatchObject({ team: 'a', playerName: 'Kim Lee', qIndex: 0 });
    expect(fake.last('disarm')).toBeTruthy();

    fake.clear();
    expect(awardPreselect()).toBe(true); // Space path
    expect(state.teamA.players[0].points).toBe(10);
    expect(state.currentQuestion).toBe(1);
    expect(state.room.preselect).toBeNull(); // cleared by reconcileRoom
    expect(fake.types()).toContain('arm');   // next question is open
  });

  it('any other scoring path also clears the preselect (number keys, buttons)', async () => {
    renderGame();
    handleRemoteBuzz('Pat');
    await tick();
    expect(state.room.preselect).toBeTruthy();
    addPoints('a', 1, 10); // moderator overrides with a different player
    expect(state.room.preselect).toBeNull();
    expect(state.teamA.players[1].points).toBe(10);
  });

  it('Esc dismisses the preselect and re-arms', async () => {
    renderGame();
    handleRemoteBuzz('Kim Lee');
    await tick();
    fake.clear();
    expect(dismissPreselect()).toBe(true);
    await tick();
    expect(state.room.preselect).toBeNull();
    expect(fake.types()).toContain('arm');
    expect(dismissPreselect()).toBe(false); // no-op without a preselect
  });

  it('navigation away drops a stale preselect', async () => {
    renderGame();
    handleRemoteBuzz('Kim Lee');
    await tick();
    state.currentQuestion = 3;
    renderGame();
    expect(state.room.preselect).toBeNull();
  });

  it('undo clears the preselect and re-opens the undone question', async () => {
    renderGame();
    addPoints('a', 0, 10); // Q1 scored, now on Q2
    handleRemoteBuzz('Pat');
    await tick();
    undoLast(); // history change -> preselect cleared, back on Q1
    expect(state.room.preselect).toBeNull();
    expect(state.currentQuestion).toBe(0);
    expect(fake.last('arm')).toBeTruthy();
  });
});

describe('silent re-arm paths', () => {
  it('re-arms without a preselect on a spectator buzz or while holding', async () => {
    renderGame();
    fake.clear();
    handleRemoteBuzz('~watch·x1');
    expect(state.room.preselect).toBeNull();
    expect(fake.types()).toContain('arm');

    state.room.hold = true;
    fake.clear();
    handleRemoteBuzz('Kim Lee');
    expect(state.room.preselect).toBeNull();
  });

  it('re-arms on a buzz from a jailbreak-locked player', async () => {
    state.questions[0] = makeQ(1, { category: 'Jailbreak' });
    renderGame();
    addPoints('a', 0, 10); // Kim scores -> locked, auto-advance
    state.currentQuestion = 0;
    state.questions[0] = makeQ(1, { category: 'Jailbreak' }); // stay in jailbreak
    state.answeredQuestions.delete(0); // re-open the slot for the round
    renderGame();
    expect(state.jailbreakLocked.a).toContain(0);
    fake.clear();
    handleRemoteBuzz('Kim Lee');
    expect(state.room.preselect).toBeNull();
    expect(fake.types()).toContain('arm');

    handleRemoteBuzz('Sam'); // unlocked teammate can still buzz
    await tick();
    expect(state.room.preselect).toMatchObject({ playerName: 'Sam' });
  });

  it('re-arms on a buzz at an already-answered question', async () => {
    renderGame();
    addPoints('a', 0, 10);
    state.currentQuestion = 0; // back on the answered question
    renderGame();
    fake.clear();
    handleRemoteBuzz('Pat');
    expect(state.room.preselect).toBeNull();
  });
});

describe('unmatched buzz -> click-to-assign', () => {
  it('assigns the phone to a roster player and the mapping persists', async () => {
    renderGame();
    handleRemoteBuzz('kimmy');
    await tick();
    expect(state.room.preselect).toMatchObject({ joinName: 'kimmy', unmatched: true });

    assignBuzzer('a', 0); // click Kim Lee's row
    await tick();
    expect(state.room.preselect).toMatchObject({ team: 'a', playerName: 'Kim Lee' });
    expect(state.room.nameMap.kimmy).toBe('Kim Lee');
    expect(awardPreselect()).toBe(true);
    expect(state.teamA.players[0].points).toBe(10);

    handleRemoteBuzz('kimmy'); // later buzz auto-matches via the map
    await tick();
    expect(state.room.preselect).toMatchObject({ team: 'a', playerName: 'Kim Lee' });
    expect(state.room.preselect.unmatched).toBeFalsy();
  });
});

describe('assign joiner to a TEAM (new roster player)', () => {
  it('adds the joiner as a new player and converts their pending unmatched buzz', async () => {
    renderGame();
    handleRemoteBuzz('Quinn');
    await tick();
    expect(state.room.preselect).toMatchObject({ joinName: 'Quinn', unmatched: true });

    assignJoinerToTeam('Quinn', 'b');
    await tick();
    expect(state.teamB.players.at(-1)).toMatchObject({ name: 'Quinn', points: 0 });
    expect(state.room.preselect).toMatchObject({ team: 'b', playerName: 'Quinn' });
    expect(awardPreselect()).toBe(true);
    expect(state.teamB.players.at(-1).points).toBe(10);

    handleRemoteBuzz('Quinn'); // later buzzes auto-match the new player
    await tick();
    expect(state.room.preselect).toMatchObject({ team: 'b', playerName: 'Quinn' });
  });

  it('works pre-buzz from the room panel, ignores duplicates and blanks', () => {
    assignJoinerToTeam('Rae', 'a');
    expect(state.teamA.players.at(-1).name).toBe('Rae');
    assignJoinerToTeam('Rae', 'b'); // already on a roster -> no-op
    expect(state.teamB.players.some((p) => p.name === 'Rae')).toBe(false);
    assignJoinerToTeam('   ', 'a');
    expect(state.teamA.players.at(-1).name).toBe('Rae');
  });

  it('supports a game started with empty rosters', async () => {
    state.teamA.players = [];
    state.teamB.players = [];
    renderGame();
    handleRemoteBuzz('Sky');
    await tick();
    expect(state.room.preselect).toMatchObject({ unmatched: true });
    assignJoinerToTeam('Sky', 'a');
    expect(awardPreselect()).toBe(true);
    expect(state.teamA.players).toEqual([{ name: 'Sky', points: 10 }]);
  });
});

describe('unlinking a wrong prefix guess', () => {
  it('pins the joiner unmatched so they can be added as their own player', async () => {
    state.teamA.players.push({ name: 'Hansen Jin', points: 0 });
    state.room.connected = ['Hansen'];
    renderGame();
    handleRemoteBuzz('Hansen'); // prefix tier guesses Hansen Jin
    await tick();
    expect(state.room.preselect).toMatchObject({ playerName: 'Hansen Jin' });
    dismissPreselect();
    await tick();
    unassignPhone('Hansen'); // host: not them
    await tick();
    expect(state.room.nameMap.Hansen).toBeNull();

    handleRemoteBuzz('Hansen'); // no re-guess — click-to-assign instead
    await tick();
    expect(state.room.preselect).toMatchObject({ joinName: 'Hansen', unmatched: true });
    assignJoinerToTeam('Hansen', 'b');
    await tick();
    expect(state.teamB.players.at(-1)).toMatchObject({ name: 'Hansen', points: 0 });
    expect(state.room.preselect).toMatchObject({ team: 'b', playerName: 'Hansen' });
    expect(state.teamA.players.some((p) => p.name === 'Hansen')).toBe(false);
  });

  it('a joiner exactly named after a roster player is untouched by someone else\'s pin', async () => {
    state.teamA.players.push({ name: 'Hansen Jin', points: 0 });
    state.room.connected = ['Hansen', 'Hansen Jin'];
    renderGame();
    handleRemoteBuzz('Hansen Jin');
    await tick();
    expect(state.room.preselect).toMatchObject({ team: 'a', playerName: 'Hansen Jin' });
  });
});

describe('streaks', () => {
  it('stays armed through streak awards and never advances', async () => {
    state.questions[2] = makeQ(3, { category: 'Streak: Capitals', streakRange: { start: 3, end: 5 } });
    rebuildStreakGroups();
    state.currentQuestion = 2;
    renderGame();
    handleRemoteBuzz('Kim Lee');
    await tick();
    expect(awardPreselect()).toBe(true); // +5
    expect(state.teamA.players[0].points).toBe(5);
    expect(state.currentQuestion).toBe(2);
    expect(fake.last('arm')).toBeTruthy();
    expect(state.room.preselect).toBeNull();
  });
});
