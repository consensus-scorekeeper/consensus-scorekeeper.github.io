// Correct-buzz counts, shown on the scorekeeper's player rows and written
// to the CSV export. Only phone-buzzer games are tracked: there,
// each buzz ends with the moderator awarding it (Space, or that player's
// +10 while their buzz is up) or dismissing it with Esc.
//
// - Correct buzzes are history entries tagged `buzz: true` (addPoints tags
//   them when the award matches the pending preselect). Living in history
//   means undo / clear / a re-award take them back off for free.
// - Wrong buzzes live on the player object as `wrongBuzzes: [{ q, after }]`
//   (slot index + state.history.length when logged, which lets undoLast
//   tell whether the wrong buzz is newer than the last scoring entry).
//   Like `subs`, they ride along through drag-reorder and persistence.
//
// Streaks are left out: one buzz earns several answers, so it isn't
// simply right or wrong. Custom awards aren't buzzes.
//
// Pure — no DOM, no state import. Tests in tests/buzzes.test.js.

export function wrongBuzzList(player) {
  return (player && Array.isArray(player.wrongBuzzes)) ? player.wrongBuzzes : [];
}

export function buzzCounts(history, team, playerIndex, player) {
  const correct = (history || []).filter((h) =>
    h.buzz && !h.isStreak && !h.isCustom && h.team === team && h.playerIndex === playerIndex
  ).length;
  return { correct, wrong: wrongBuzzList(player).length };
}

// CSV cells: blank when the player had no buzzes (game without buzzers,
// or a player scored with number keys), so "untracked" never reads as
// 0 of 0.
export function formatBuzzCells({ correct, wrong }) {
  return correct + wrong > 0 ? [correct, wrong] : ['', ''];
}
