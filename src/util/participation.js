// Substitutions. A roster player carries `subs`: a list of benched
// intervals over slot indices, `{ out, in }` — `out` is the first slot the
// player sat out, `in` the first slot they were back for (null while still
// on the bench). A player with no `subs` (every roster built before this
// existed, every CSV exported before the Played column) played the whole
// game.
//
// "How much of the game did they play" is measured in playable slots —
// the pack's real question slots (padded gaps excluded) — because that is
// the unit scoring weight is spread over: sub out at Q51 of a 100-slot
// pack = half a game, no matter how many of those questions got answered.
//
// Pure — no DOM, no state import. Tests in tests/participation.test.js.

export function subIntervals(player) {
  return (player && Array.isArray(player.subs)) ? player.subs : [];
}

// Currently on the bench (latest interval still open)?
export function isBenched(player) {
  const subs = subIntervals(player);
  const last = subs[subs.length - 1];
  return !!last && last.in == null;
}

// Was the player benched for slot `slot`?
export function isBenchedAt(player, slot) {
  return subIntervals(player).some((s) => slot >= s.out && (s.in == null || slot < s.in));
}

// Slot indices that count toward the game: real questions, not the
// placeholders padQuestionsToSlots inserts for packet gaps.
export function playableSlots(questions) {
  const out = [];
  (questions || []).forEach((q, i) => { if (!q || !q.isMissing) out.push(i); });
  return out;
}

export function slotsPlayed(player, questions) {
  return playableSlots(questions).filter((i) => !isBenchedAt(player, i)).length;
}

// Fraction of the game the player was available for, in [0, 1]. With no
// questions there is nothing to measure against, so everyone played 1.
export function playedFraction(player, questions) {
  const slots = playableSlots(questions);
  if (slots.length === 0) return 1;
  return slots.filter((i) => !isBenchedAt(player, i)).length / slots.length;
}

// The `Played` CSV cell: a short decimal, exact for 100-slot packs
// (0.37), three places otherwise.
export function formatPlayed(fraction) {
  const f = Math.max(0, Math.min(1, Number(fraction)));
  return String(Math.round(f * 1000) / 1000);
}

// Inverse of formatPlayed for the CSV parser. Missing/blank (a CSV from
// before the column existed) or unparseable cells mean a full game.
export function parsePlayed(cell) {
  if (cell === undefined || cell === null || String(cell).trim() === '') return 1;
  const n = parseFloat(cell);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}
