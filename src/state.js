// The application's single mutable state object plus the named reducers
// that mutate it. UI modules call these reducers — they should never
// touch state.foo = ... directly.
//
// After every reducer mutates state, it calls notify() which invokes all
// registered subscribers. main.js subscribes renderGame so the UI is
// kept in sync; tests don't subscribe so they only assert on the resulting
// state shape.

export const state = {
  teamA: { name: 'Team A', players: [], score: 0 },
  teamB: { name: 'Team B', players: [], score: 0 },
  questions: [],
  currentQuestion: 0,
  hasQuestions: false,
  history: [],
  answeredQuestions: new Set(),
  zipPacks: null,
  packName: null,
  // Suspected parsing issues from the last pack load (see
  // parser/diagnostics.js). Drives the parse report on the setup screen and
  // the per-slot warning flags in-game.
  parseIssues: [],
  pdfBytes: null,
  pdfViewer: { doc: null, currentPage: 1, inlinePage: null },
  inlinePdfHidden: false,
  // Jailbreak lockout state — which player indices on each team have already
  // buzzed in the current jailbreak round. Reset to [] when the team is full
  // (rebuildJailbreakLocks reconstructs this from state.history every render).
  jailbreakLocked: { a: [], b: [] },
  // Tutorial sandbox flag. When true, game/persistence.js's saveState +
  // savePdfBytes early-return so the tutorial doesn't overwrite any
  // saved real game. Transient — defaults to false on every page load.
  tutorialMode: false,
};

// ==================== SUBSCRIBE ====================
const subscribers = [];

export function subscribe(fn) {
  subscribers.push(fn);
  return () => {
    const i = subscribers.indexOf(fn);
    if (i !== -1) subscribers.splice(i, 1);
  };
}

function notify() {
  for (const fn of subscribers) {
    try { fn(); } catch (e) { console.error('[state] subscriber threw:', e); }
  }
}

// ==================== REDUCERS ====================

export function addPoints(team, playerIndex, points) {
  const teamObj = team === 'a' ? state.teamA : state.teamB;
  const q = state.questions[state.currentQuestion];

  // On streak questions, force +5 and don't auto-advance.
  // Streaks are the only question type where both teams can score in the same group,
  // so streak scoring is bucketed per team: { a?: {playerIndex, totalPoints}, b?: ... }
  if (q && q.isStreak) {
    const streakKey = q.streakGroupStart;
    if (!state.streakScoring[streakKey]) state.streakScoring[streakKey] = {};
    const bucket = state.streakScoring[streakKey];

    // Within a single team only one player tracks the streak; if a different
    // player on the same team clicks (misclick correction), wipe that team's
    // running total and start fresh. The other team's bucket is untouched.
    const existing = bucket[team];
    if (existing && existing.playerIndex !== playerIndex) {
      teamObj.players[existing.playerIndex].points -= existing.totalPoints;
      teamObj.score -= existing.totalPoints;
      state.history = state.history.filter(h => !(h.isStreak && h.streakKey === streakKey && h.team === team));
      bucket[team] = null;
    }

    if (!bucket[team]) bucket[team] = { playerIndex, totalPoints: 0 };
    const addPts = 5;
    teamObj.players[playerIndex].points += addPts;
    teamObj.score += addPts;
    bucket[team].totalPoints += addPts;
    state.history.push({ team, playerIndex, points: addPts, question: state.currentQuestion, isStreak: true, streakKey });
    state.answeredQuestions.add(state.currentQuestion);
    notify();
    return;
  }

  // If question already answered by someone else, remove their points first.
  // Custom dev-tool awards are not considered "the prior answer" — they stack alongside.
  if (state.answeredQuestions.has(state.currentQuestion)) {
    const prevEntry = [...state.history].reverse().find(h => h.question === state.currentQuestion && !h.isStreak && !h.isCustom);
    if (prevEntry) {
      const prevTeamObj = prevEntry.team === 'a' ? state.teamA : state.teamB;
      prevTeamObj.players[prevEntry.playerIndex].points -= prevEntry.points;
      prevTeamObj.score -= prevEntry.points;
      state.history = state.history.filter(h => h !== prevEntry);
    }
  }

  teamObj.players[playerIndex].points += points;
  teamObj.score += points;
  state.history.push({ team, playerIndex, points, question: state.currentQuestion });
  state.answeredQuestions.add(state.currentQuestion);
  if (state.currentQuestion < state.questions.length - 1) {
    state.currentQuestion++;
  }
  notify();
}

export function clearPlayerPoints(team, playerIndex) {
  const teamObj = team === 'a' ? state.teamA : state.teamB;
  const entryIdx = state.history.findIndex(h =>
    h.question === state.currentQuestion && h.team === team && h.playerIndex === playerIndex && !h.isStreak && !h.isCustom
  );
  if (entryIdx === -1) return;
  const entry = state.history[entryIdx];
  teamObj.players[playerIndex].points -= entry.points;
  teamObj.score -= entry.points;
  state.history.splice(entryIdx, 1);
  const stillAnswered = state.history.some(h => h.question === state.currentQuestion && !h.isStreak);
  if (!stillAnswered) state.answeredQuestions.delete(state.currentQuestion);
  notify();
}

// Clear whoever is assigned points on the current non-streak question.
// (On a normal question only one entry exists; streaks use resetStreak.)
export function clearCurrentQuestion() {
  const q = state.questions[state.currentQuestion];
  if (q && q.isStreak) return;
  // Only clears the normal-scoring entry. Custom dev-tool awards are not
  // touched here — undo them with Undo Last or another custom award with
  // the inverse points.
  const entryIdx = state.history.findIndex(h => h.question === state.currentQuestion && !h.isStreak && !h.isCustom);
  if (entryIdx === -1) return;
  const entry = state.history[entryIdx];
  const teamObj = entry.team === 'a' ? state.teamA : state.teamB;
  teamObj.players[entry.playerIndex].points -= entry.points;
  teamObj.score -= entry.points;
  state.history.splice(entryIdx, 1);
  const stillAnswered = state.history.some(h => h.question === state.currentQuestion);
  if (!stillAnswered) state.answeredQuestions.delete(state.currentQuestion);
  notify();
}

export function resetStreak(streakKey, team) {
  const bucket = state.streakScoring[streakKey];
  const entry = bucket && bucket[team];
  if (!entry || entry.totalPoints === 0) return;

  const teamObj = team === 'a' ? state.teamA : state.teamB;
  teamObj.players[entry.playerIndex].points -= entry.totalPoints;
  teamObj.score -= entry.totalPoints;

  state.history = state.history.filter(h => !(h.isStreak && h.streakKey === streakKey && h.team === team));
  entry.totalPoints = 0;

  const group = state.streakGroups[streakKey];
  if (group) {
    for (const m of group.members) {
      const stillAnswered = state.history.some(h => h.question === m);
      if (!stillAnswered) state.answeredQuestions.delete(m);
    }
  }

  notify();
}

// Award arbitrary points to a player. The dev-tools UI handles input
// validation and reads the form fields; this reducer just performs the
// mutation given clean values.
export function applyCustomAward(team, playerIndex, points, questionIdx) {
  const teamObj = team === 'a' ? state.teamA : state.teamB;
  teamObj.players[playerIndex].points += points;
  teamObj.score += points;
  state.history.push({ team, playerIndex, points, question: questionIdx, isCustom: true });
  state.answeredQuestions.add(questionIdx);
  notify();
}

// Move a player from `fromIndex` to `toIndex` within `team`'s players array,
// then remap every other piece of state that references players by index:
// state.history entries (for this team), state.streakScoring[*][team], and
// state.jailbreakLocked[team]. This is what makes drag-to-reorder safe
// mid-game — points, streaks, and jailbreak locks stay attached to the right
// player after the move. CSV export reads from teamObj.players in order, so
// the exported row order reflects whatever the moderator left the roster in.
export function reorderPlayer(team, fromIndex, toIndex) {
  const teamObj = team === 'a' ? state.teamA : state.teamB;
  const n = teamObj.players.length;
  fromIndex = Math.max(0, Math.min(n - 1, fromIndex | 0));
  toIndex = Math.max(0, Math.min(n - 1, toIndex | 0));
  if (n < 2 || fromIndex === toIndex) return;

  // Build oldIdx -> newIdx mapping based on splice-out then splice-in semantics.
  const mapping = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i === fromIndex) mapping[i] = toIndex;
    else if (fromIndex < toIndex && i > fromIndex && i <= toIndex) mapping[i] = i - 1;
    else if (fromIndex > toIndex && i >= toIndex && i < fromIndex) mapping[i] = i + 1;
    else mapping[i] = i;
  }

  const [moved] = teamObj.players.splice(fromIndex, 1);
  teamObj.players.splice(toIndex, 0, moved);

  for (const h of state.history) {
    if (h.team === team && typeof h.playerIndex === 'number') {
      h.playerIndex = mapping[h.playerIndex];
    }
  }

  if (state.streakScoring) {
    for (const key of Object.keys(state.streakScoring)) {
      const bucket = state.streakScoring[key];
      if (bucket && bucket[team] && typeof bucket[team].playerIndex === 'number') {
        bucket[team].playerIndex = mapping[bucket[team].playerIndex];
      }
    }
  }

  if (state.jailbreakLocked && Array.isArray(state.jailbreakLocked[team])) {
    state.jailbreakLocked[team] = state.jailbreakLocked[team].map((i) => mapping[i]);
  }

  notify();
}

export function undoLast() {
  if (state.history.length === 0) return;
  const last = state.history.pop();
  const teamObj = last.team === 'a' ? state.teamA : state.teamB;
  teamObj.players[last.playerIndex].points -= last.points;
  teamObj.score -= last.points;
  const stillAnswered = state.history.some(h => h.question === last.question);
  if (!stillAnswered) state.answeredQuestions.delete(last.question);
  // Update streak scoring state if this was a streak action
  if (last.isStreak) {
    const bucket = state.streakScoring[last.streakKey];
    if (bucket && bucket[last.team]) bucket[last.team].totalPoints -= last.points;
  }
  state.currentQuestion = last.question;
  notify();
}
