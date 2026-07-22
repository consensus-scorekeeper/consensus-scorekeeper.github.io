// Pure decision logic for phone-buzzer rooms (see src/ui/room.js for the
// WebSocket/DOM glue). Everything here takes `state` as an argument and
// touches no DOM, no network, no module-level state — so the arm
// lifecycle, name matching, and past-questions rules are unit-testable
// with the real reducers.

import { escapeHtml } from '../util/escape.js';

// Phones connecting from a spectator link (?watch=1) join with this name
// prefix. They never buzz; the host filters them out of the phones list
// and defensively re-arms if a tampered page sends a buzz anyway.
export const SPECTATOR_PREFIX = '~watch';

export function isSpectatorName(name) {
  return String(name || '').startsWith(SPECTATOR_PREFIX);
}

export function isJailbreakQuestion(q) {
  return !!(q && q.category && /jailbreak/i.test(q.category));
}

// Should the phones' buzz buttons be open right now? "Armed" in the
// Consensus format (no reading clock — the moderator reads aloud) means
// "the current question is open for scoring":
//   - normal question: armed until someone scores it; the award's
//     auto-advance lands on an unanswered slot, which re-arms.
//   - streak slot: always armed — both teams keep scoring +5s with no
//     auto-advance, so answeredQuestions is ignored.
//   - pending preselect (a phone buzzed, moderator adjudicating), the
//     hold-buzzers toggle, or a missing/empty slot: closed.
//   - undo / navigation land on whatever the predicate says for the new
//     current question (undo re-opens the undone question by design).
// Jailbreak lockouts are handled per-buzz (silent re-arm in
// handleRemoteBuzz), not by closing the gate for everyone.
export function computeDesiredArmed(state, room) {
  if (!room || room.hold || room.preselect) return false;
  const q = state.questions[state.currentQuestion];
  if (!q) return false;
  if (q.isStreak) return true;
  if (q.isMissing) return false;
  if (!q.question) return false; // empty placeholder slot
  return !state.answeredQuestions.has(state.currentQuestion);
}

function normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Map a phone's join name to a roster player. Precedence: the host's
// explicit assignment map (join name -> roster player NAME — stored by
// name, not index, so drag-reorder can't stale it), then normalized
// exact match, then a unique-prefix match ("kim" -> "Kim Lee", or
// "kimberly l" -> "Kimberly"). The prefix tier never claims a roster
// player who plainly belongs to a DIFFERENT joiner — one whose exact
// name is another connected phone, or one another join name is
// explicitly assigned to — so a "Hansen" can't collapse into a
// "Hansen Jin" who has their own phone. A null nameMap entry is a host
// pin ("not who you guessed", set by the panel's unlink button): it
// disables the prefix tier for that join name until an explicit
// assignment replaces it. Ambiguous or no match -> null (the host gets
// a click-to-assign affordance). Duplicate roster names: first match
// wins.
export function matchNameToRoster(joinName, state, nameMap = {}) {
  const jn = normName(joinName);
  if (!jn) return null;
  const hits = (pred) => {
    const out = [];
    for (const [team, teamObj] of [['a', state.teamA], ['b', state.teamB]]) {
      teamObj.players.forEach((p, i) => {
        if (pred(normName(p.name))) out.push({ team, playerIndex: i, playerName: p.name });
      });
    }
    return out;
  };
  const mapped = nameMap[joinName];
  if (mapped) {
    const m = hits((n) => n === normName(mapped));
    if (m.length) return m[0];
  }
  const exact = hits((n) => n === jn);
  if (exact.length) return exact[0];
  if (joinName in nameMap && !mapped) return null; // host pin: no guessing
  const claimed = new Set();
  for (const other of (state.room && state.room.connected) || []) {
    const on = normName(other);
    if (on !== jn) claimed.add(on);
  }
  for (const [other, rosterName] of Object.entries(nameMap)) {
    if (rosterName && normName(other) !== jn) claimed.add(normName(rosterName));
  }
  const prefix = hits((n) => !claimed.has(n) && (n.startsWith(jn) || jn.startsWith(n)));
  if (prefix.length === 1) return prefix[0];
  return null;
}

function summarizeEntry(state, entry) {
  const teamObj = entry.team === 'a' ? state.teamA : state.teamB;
  const p = teamObj.players[entry.playerIndex];
  return `${p ? p.name : '?'} +${entry.points} (${teamObj.name})`;
}

// Past-questions log for the phones, rebuilt from scratch on every call
// (same stance as rebuildJailbreakLocks — derive, never accumulate — so
// undo/clear/re-award stay correct for free). Spoiler rules:
//   - a normal question appears only once ANSWERED and NO LONGER CURRENT
//     (the live question's answer must never reach the phones — jumping
//     back to an answered question hides it again while re-adjudicating);
//   - a streak group appears only once the moderator has moved PAST it
//     and it was scored (showing it earlier leaks the remaining parts —
//     same rule that hides posNum for streaks in the scoreboard);
//   - skipped/unanswered questions never appear (the moderator may
//     come back to them).
// Entries are chronological (pack order); renderers show newest first.
// `answerHtml` is trusted parser output (richToHtml escapes segment
// text) or escaped here — safe to inject in the player page.
export function buildQlog(state) {
  const log = [];
  const qs = state.questions;
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    if (!q) continue;
    if (q.isStreak) {
      if (q.streakGroupStart !== i) continue; // one entry per group
      const group = state.streakGroups && state.streakGroups[i];
      if (!group || state.currentQuestion <= group.end) continue;
      const bucket = (state.streakScoring && state.streakScoring[i]) || {};
      const parts = [];
      for (const t of ['a', 'b']) {
        const e = bucket[t];
        if (!e || !e.totalPoints) continue;
        const teamObj = t === 'a' ? state.teamA : state.teamB;
        const p = teamObj.players[e.playerIndex];
        parts.push(`${p ? p.name : '?'} +${e.totalPoints} (${teamObj.name})`);
      }
      if (!parts.length) continue; // passed without scoring — treat as skipped
      const src = group.sourceQuestion || q;
      log.push({
        label: `Q${qs[group.start].num}–${qs[group.end].num}`,
        category: group.category || src.category || null,
        question: src.question || '',
        answerHtml: src.answerHtml || (src.answer ? escapeHtml(src.answer) : ''),
        summary: parts.join(' · '),
      });
      continue;
    }
    if (i === state.currentQuestion) continue;
    if (!state.answeredQuestions.has(i)) continue;
    const entry = [...state.history].reverse().find((h) => h.question === i && !h.isStreak);
    log.push({
      label: `Q${q.num}`,
      category: q.category || null,
      question: q.question || '',
      answerHtml: q.answerHtml || (q.answer ? escapeHtml(q.answer) : ''),
      summary: entry ? summarizeEntry(state, entry) : 'scored',
    });
  }
  return log;
}
