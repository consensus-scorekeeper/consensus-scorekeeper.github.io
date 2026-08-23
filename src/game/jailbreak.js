// Reconstruct jailbreak per-team lockouts from state.history. Walking
// history in order means that any change (undo, clear, custom award) is
// reflected automatically — we never have to keep two sources of truth in
// sync. A team's lock resets the moment every player AVAILABLE to it has
// buzzed — subbed-out players don't count toward the round (a 5-person
// roster with one on the bench cycles after 4 buzzes), and a player who
// buzzed before being benched doesn't block the reset either.

import { state } from '../state.js';
import { isBenchedAt } from '../util/participation.js';

function roundComplete(team, lock, slot) {
  const players = team === 'a' ? state.teamA.players : state.teamB.players;
  const available = [];
  players.forEach((p, i) => { if (!isBenchedAt(p, slot)) available.push(i); });
  return available.length > 0 && available.every((i) => lock.includes(i));
}

export function rebuildJailbreakLocks() {
  state.jailbreakLocked = { a: [], b: [] };
  for (const h of state.history) {
    if (h.isStreak) continue;
    const q = state.questions[h.question];
    if (!q || !q.category || !/jailbreak/i.test(q.category)) continue;
    const lock = state.jailbreakLocked[h.team];
    if (!lock.includes(h.playerIndex)) lock.push(h.playerIndex);
    // Availability as of the buzz: replaying an old round with today's
    // bench would reset it early (or never).
    if (roundComplete(h.team, lock, h.question)) state.jailbreakLocked[h.team] = [];
  }
  // A substitution can complete a round with no buzz at all — the last
  // unlocked player just left — so re-check against the current slot.
  for (const team of ['a', 'b']) {
    const lock = state.jailbreakLocked[team];
    if (lock.length && roundComplete(team, lock, state.currentQuestion)) state.jailbreakLocked[team] = [];
  }
}
