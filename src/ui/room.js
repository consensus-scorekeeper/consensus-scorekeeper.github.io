// Phone-buzzer rooms: WebSocket/DOM glue around the pure rules in
// game/room-logic.js. Players join on their phones via player.html
// (buzz button + live scoreboard + past questions); this module runs on
// the moderator's machine as the room host.
//
// Architecture (shared with qb-moderator, whose deployed worker we use):
// the room server is a dumb host-authoritative relay — one Durable
// Object per room doing atomic first-buzz arbitration and fan-out. The
// game state stays entirely in this app; we push a display snapshot
// (the same one the pop-out scoreboard renders) after every render, arm
// or disarm the phones' buzz buttons, and push a spoiler-safe
// past-questions log. A winning remote buzz PRESELECTS the matched
// roster player — the moderator stays the verdict authority (Space
// awards, Esc dismisses); nothing is ever auto-scored.
//
// The room client (src/vendor/room.js) is vendored byte-identical from
// ../qb-moderator/app/room.js — never edit it here.

import { state, addPoints, addRosterPlayer } from '../state.js';
import { createRoom, connectHost } from '../vendor/room.js';
import { getScoreboardSnapshot } from './scoreboard-popout.js';
import {
  computeDesiredArmed, matchNameToRoster, buildQlog,
  isSpectatorName, isJailbreakQuestion,
} from '../game/room-logic.js';
import { isGameVisible } from '../game/persistence.js';
import { escapeHtml } from '../util/escape.js';

let room = null;           // connectHost handle, or null
let wsUp = false;          // current WebSocket connectivity (for the panel)
let lastSentArmed = null;  // diff guard — resync on reconnect via null
let lastSentQlog = null;   // JSON of the last pushed qlog
let lastHistoryLen = 0;    // any scoring change clears the preselect

// Self-hosters can point at their own worker deployment (same escape
// hatch as qb-moderator): ?roomserver= wins, then localStorage.
function serverOverride() {
  const p = new URLSearchParams(location.search).get('roomserver');
  if (p) return p;
  try { return localStorage.getItem('consensus-room-server') || undefined; } catch (e) { return undefined; }
}

async function rerender() {
  const { renderGame } = await import('./game.js');
  renderGame();
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => window.prompt('Copy this link:', text));
  } else {
    window.prompt('Copy this link:', text);
  }
}

// ==================== room lifecycle ====================

export async function createAndJoinRoom() {
  if (room) return;
  let code;
  try {
    code = await createRoom(serverOverride());
  } catch (e) {
    alert('Could not create a room (is the room server reachable?)\n' + e.message);
    return;
  }
  room = connectHost(code, {
    onOpen: () => {
      wsUp = true;
      // Resync everything after (re)connect — the DO may have stale or no
      // state for us, and welcome replays existing players through onJoin.
      lastSentArmed = null;
      lastSentQlog = null;
      rerender();
    },
    onClose: () => { wsUp = false; rerender(); },
    onJoin: (name) => {
      if (!isSpectatorName(name)) state.room.connected.push(name);
      rerender();
    },
    onLeave: (name) => {
      const i = state.room.connected.indexOf(name);
      if (i !== -1) state.room.connected.splice(i, 1);
      rerender();
    },
    onBuzz: (name) => handleRemoteBuzz(name),
  }, serverOverride());
  state.room.active = true;
  state.room.code = code;
  lastHistoryLen = state.history.length;
  rerender();
}

export function closeRoom() {
  if (!room) return;
  try { room.send({ t: 'disarm' }); } catch (e) { /* closing */ }
  room.close();
  room = null;
  wsUp = false;
  lastSentArmed = null;
  lastSentQlog = null;
  state.room = { active: false, code: null, connected: [], nameMap: {}, preselect: null, hold: false };
  rerender();
}

export function copyPlayerLink() {
  if (room) copyText(room.playerUrl());
}

export function copySpectatorLink() {
  if (room) copyText(room.playerUrl() + '&watch=1');
}

export function toggleHold() {
  if (!room) return;
  state.room.hold = !state.room.hold;
  rerender();
}

export function unassignPhone(joinName) {
  delete state.room.nameMap[joinName];
  rerender();
}

// ==================== buzzing ====================

// The DO closed the gate for a buzz we won't act on (spectator, hold,
// locked-out player, already-answered question). Reopen it without
// bothering the moderator: forcing the diff guard makes syncRoom resend
// {t:'arm'} — the same silent re-arm qb-moderator uses for lockouts.
function silentRearm() {
  lastSentArmed = null;
  syncRoom();
}

export function handleRemoteBuzz(name) {
  if (!room) return;
  if (isSpectatorName(name) || state.room.hold || !isGameVisible()) return silentRearm();
  if (state.room.preselect) return silentRearm(); // already adjudicating one
  const q = state.questions[state.currentQuestion];
  if (!q || q.isMissing || (!q.question && !q.isStreak)) return silentRearm();
  if (!q.isStreak && state.answeredQuestions.has(state.currentQuestion)) return silentRearm();

  const match = matchNameToRoster(name, state, state.room.nameMap);
  if (match && isJailbreakQuestion(q)
      && state.jailbreakLocked[match.team].includes(match.playerIndex)) {
    return silentRearm(); // locked this jailbreak round — phones reopen
  }
  state.room.preselect = match
    ? { joinName: name, team: match.team, playerName: match.playerName, qIndex: state.currentQuestion }
    : { joinName: name, unmatched: true, qIndex: state.currentQuestion };
  rerender();
}

// Resolve a matched preselect to the player's CURRENT roster index
// (drag-reorder safe: stored by name).
export function preselectIndex(ps = state.room.preselect) {
  if (!ps || ps.unmatched) return null;
  const teamObj = ps.team === 'a' ? state.teamA : state.teamB;
  const i = teamObj.players.findIndex((p) => p.name === ps.playerName);
  return i === -1 ? null : { team: ps.team, playerIndex: i };
}

// Space/Enter keybind: award the preselected buzzer. Returns true if
// consumed. The preselect clears via the history-change check in
// syncRoom, which the reducer's notify() triggers.
export function awardPreselect() {
  const ps = state.room.preselect;
  const at = preselectIndex(ps);
  if (!at) return false;
  const q = state.questions[state.currentQuestion];
  addPoints(at.team, at.playerIndex, q && q.isStreak ? 5 : 10);
  return true;
}

// Esc keybind: wrong answer / accidental buzz — drop the preselect and
// bounce the buzzers back open for everyone. Returns true if consumed.
export function dismissPreselect() {
  if (!state.room.preselect) return false;
  state.room.preselect = null;
  lastSentArmed = null;
  rerender();
  return true;
}

// Add a joiner as a NEW roster player on the given team. Rooms are not
// phone-only (computers join too) and a game may start with empty
// rosters — the moderator builds the teams as people join. Converts a
// pending unmatched buzz from that joiner into a matched preselect.
export function assignJoinerToTeam(joinName, team) {
  const clean = String(joinName || '').trim();
  if (!clean || (team !== 'a' && team !== 'b')) return;
  if (matchNameToRoster(joinName, state, state.room.nameMap)) return; // already on a roster
  if (addRosterPlayer(team, clean) === -1) return;
  state.room.nameMap[joinName] = clean;
  const ps = state.room.preselect;
  if (ps && ps.unmatched && ps.joinName === joinName) {
    state.room.preselect = { joinName, team, playerName: clean, qIndex: ps.qIndex };
  }
  rerender();
}

// Click-to-assign for an unmatched buzzer: bind the phone's join name to
// a roster player (persists for the session) and convert the pending
// preselect to a matched one.
export function assignBuzzer(team, playerIndex) {
  const ps = state.room.preselect;
  if (!ps || !ps.unmatched) return;
  const teamObj = team === 'a' ? state.teamA : state.teamB;
  const p = teamObj.players[playerIndex];
  if (!p) return;
  state.room.nameMap[ps.joinName] = p.name;
  state.room.preselect = { joinName: ps.joinName, team, playerName: p.name, qIndex: ps.qIndex };
  rerender();
}

// ==================== render-cycle hooks (called by renderGame) ====================

// Before the panels render: drop a preselect that went stale — the
// moderator scored (any path: number keys, +10 buttons, undo) or moved
// to a different question.
export function reconcileRoom() {
  if (!room) return;
  if (state.history.length !== lastHistoryLen) {
    lastHistoryLen = state.history.length;
    state.room.preselect = null;
  } else if (state.room.preselect && state.room.preselect.qIndex !== state.currentQuestion) {
    state.room.preselect = null;
  }
}

// After the render: push snapshot + arm state + qlog to the phones, then
// redraw the room bar/panel DOM.
export function syncRoom() {
  if (room) {
    room.send({ t: 'state', snapshot: getScoreboardSnapshot() });
    const want = !!(isGameVisible() && computeDesiredArmed(state, state.room));
    if (want !== lastSentArmed) {
      lastSentArmed = want;
      room.send({ t: want ? 'arm' : 'disarm' });
    }
    const qlog = buildQlog(state);
    const ser = JSON.stringify(qlog);
    if (ser !== lastSentQlog) {
      lastSentQlog = ser;
      room.send({ t: 'qlog', qlog });
    }
  }
  renderRoomUI();
}

// ==================== test seam ====================

// Inject a fake room handle ({send, close, playerUrl, code}) so tests can
// drive the host integration without a WebSocket. Pass null to detach.
export function _setRoomForTest(fake) {
  room = fake;
  wsUp = !!fake;
  lastSentArmed = null;
  lastSentQlog = null;
  lastHistoryLen = state.history.length;
  state.room.active = !!fake;
  state.room.code = fake ? (fake.code || 'TEST') : null;
}

// ==================== room UI (buzz bar + panel body) ====================

function renderRoomUI() {
  const bar = document.getElementById('room-buzz-bar');
  if (bar) {
    const ps = state.room.preselect;
    if (!room || !ps) {
      bar.style.display = 'none';
      bar.innerHTML = '';
    } else if (ps.unmatched) {
      bar.className = 'room-buzz-bar unmatched';
      bar.innerHTML = `&#128276; <strong>${escapeHtml(ps.joinName)}</strong> buzzed &mdash; `
        + `click a player row to link them, or add as a new player: `
        + `<button class="btn" data-action="room-join-team" data-name="${escapeHtml(ps.joinName)}" data-team="a">+ ${escapeHtml(state.teamA.name)}</button> `
        + `<button class="btn" data-action="room-join-team" data-name="${escapeHtml(ps.joinName)}" data-team="b">+ ${escapeHtml(state.teamB.name)}</button>`
        + ` &middot; Esc dismisses`;
      bar.style.display = 'block';
    } else {
      const q = state.questions[state.currentQuestion];
      const pts = q && q.isStreak ? 5 : 10;
      const teamObj = ps.team === 'a' ? state.teamA : state.teamB;
      bar.className = 'room-buzz-bar';
      bar.innerHTML = `&#128276; <strong>${escapeHtml(ps.playerName)}</strong> (${escapeHtml(teamObj.name)}) buzzed &mdash; Space awards +${pts} &middot; Esc dismisses`;
      bar.style.display = 'block';
    }
  }

  const summary = document.getElementById('room-summary');
  if (summary) {
    summary.innerHTML = room
      ? `&#128241; ${escapeHtml(state.room.code)}${wsUp ? '' : ' &#9888;'} &#9662;`
      : '&#128241; Buzzers &#9662;';
  }

  const body = document.getElementById('room-panel-body');
  if (!body) return;
  if (!room) {
    body.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px">Remote buzzers</div>
      <div class="room-hint">Players join on their phones or computers with a room code: a
        big buzz button (Space on a keyboard) plus the live scoreboard and past questions.</div>
      <button class="btn" data-action="room-create">Create room</button>`;
    return;
  }
  const joiners = state.room.connected.map((n) => {
    const m = matchNameToRoster(n, state, state.room.nameMap);
    const status = m
      ? `&rarr; ${escapeHtml(m.playerName)} (${m.team === 'a' ? escapeHtml(state.teamA.name) : escapeHtml(state.teamB.name)})`
      : `<button class="btn room-x" data-action="room-join-team" data-name="${escapeHtml(n)}" data-team="a" title="Add as a new player on ${escapeHtml(state.teamA.name)}">+ ${escapeHtml(state.teamA.name)}</button>`
        + ` <button class="btn room-x" data-action="room-join-team" data-name="${escapeHtml(n)}" data-team="b" title="Add as a new player on ${escapeHtml(state.teamB.name)}">+ ${escapeHtml(state.teamB.name)}</button>`;
    const unassign = state.room.nameMap[n]
      ? ` <button class="btn room-x" data-action="room-unassign" data-name="${escapeHtml(n)}" title="Forget this assignment">&times;</button>`
      : '';
    return `<div class="room-phone">${escapeHtml(n)} ${status}${unassign}</div>`;
  }).join('') || '<div class="room-hint">No players connected yet.</div>';
  body.innerHTML = `
    <div class="room-code-row">Room <strong class="room-code">${escapeHtml(state.room.code)}</strong>
      <span class="room-hint">${wsUp ? 'connected' : 'reconnecting&hellip;'}</span></div>
    <div class="room-link-row">
      <button class="btn" data-action="room-copy-player">Copy player link</button>
      <button class="btn" data-action="room-copy-spectator">Copy spectator link</button>
    </div>
    <label class="room-hold-row" title="Buzz buttons go dark on every connected device and any buzz that sneaks in is ignored — for reading rules, settling disputes, or between rounds"><input type="checkbox" data-action="room-hold" ${state.room.hold ? 'checked' : ''}> Hold buzzers (stop accepting buzzes until unchecked)</label>
    <div class="room-phones">${joiners}</div>
    <button class="btn" data-action="room-close">Close room</button>`;
}
