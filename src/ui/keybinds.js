// Global keyboard shortcuts (active only when the game screen is visible
// and no input/textarea/select has focus).
//
// - Number keys: 1-4 = Team A players (indices 0-3), 5-9 = Team B players
//   (indices 0-4). Team B always starts at 5 regardless of how many players
//   Team A has, so the slot a player occupies on a key never shifts when
//   the moderator adds/removes a teammate.
// - 0 (no shift) = next question. Shift+0 = Team B's 6th player (index 5).
// - Arrow Left / Right: prev / next question.
// - Ctrl+Z: undo last scoring action.
// - C: clear the current question's points.
// - Space / Enter: award the phone-buzz preselect (+10 / +5 streak);
//   Esc: dismiss it and re-open the buzzers. No-ops without a preselect.
//
// PDF overlay short-circuits this — its own listener (in ui/pdf-viewer.js)
// owns Esc / arrows while the overlay is open.

import { state, addPoints, undoLast, clearCurrentQuestion } from '../state.js';
import { isGameVisible } from '../game/persistence.js';
import { isBenched } from '../util/participation.js';
import { awardPreselect, dismissPreselect } from './room.js';

export function setupKeybinds({ nextQuestion, prevQuestion }) {
  // Window-level capture-phase logger for debugging stuck keys. Toggle on
  // with `window.DEBUG_KEYS = true` from devtools.
  window.addEventListener('keydown', (e) => {
    if (window.DEBUG_KEYS) {
      console.log('[window-capture keydown]', { key: e.key, code: e.code, which: e.which, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, target: e.target && (e.target.tagName + (e.target.id ? '#' + e.target.id : '') + (e.target.className ? '.' + String(e.target.className).split(' ').join('.') : '')) });
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (window.DEBUG_KEYS) {
      console.log('[document keydown]', { key: e.key, code: e.code, repeat: e.repeat, gameVisible: isGameVisible(), targetTag: e.target && e.target.tagName, currentQ: state.currentQuestion, players: state.teamA.players.length + state.teamB.players.length });
    }
    if (e.repeat) return;
    const pdfOverlay = document.getElementById('pdf-overlay');
    if (pdfOverlay && pdfOverlay.classList.contains('open')) { if (window.DEBUG_KEYS) console.log('[keydown] return: pdf overlay open'); return; }
    if (!isGameVisible()) { if (window.DEBUG_KEYS) console.log('[keydown] return: game not visible'); return; }
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (window.DEBUG_KEYS) console.log('[keydown] return: focused on', tag); return; }

    // Phone-buzzer preselect verdicts. preventDefault only when consumed —
    // it also kills the synthesized click a focused button would get.
    if ((e.key === ' ' || e.key === 'Enter') && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (awardPreselect()) { e.preventDefault(); return; }
    }
    if (e.key === 'Escape') {
      if (dismissPreselect()) e.preventDefault();
      return;
    }

    if (e.key === 'ArrowRight') { e.preventDefault(); nextQuestion(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); prevQuestion(); return; }
    if (e.key === 'z' && e.ctrlKey) { e.preventDefault(); undoLast(); return; }
    if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      clearCurrentQuestion();
      return;
    }

    if (e.key >= '0' && e.key <= '9' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const keyNum = parseInt(e.key, 10);
      // 0 (no shift) = next question. Shift+0 reaches Team B's 6th player.
      if (keyNum === 0 && !e.shiftKey) {
        e.preventDefault();
        nextQuestion();
        return;
      }
      // Team A: keys 1-4 → indices 0-3. Team B: keys 5-9 → indices 0-4; key 0 → index 5.
      let team, playerIdx;
      if (keyNum === 0)      { team = 'b'; playerIdx = 5; }
      else if (keyNum <= 4)  { team = 'a'; playerIdx = keyNum - 1; }
      else                   { team = 'b'; playerIdx = keyNum - 5; }
      const teamPlayers = team === 'a' ? state.teamA.players : state.teamB.players;
      if (window.DEBUG_KEYS) console.log('[keydown] team=', team, 'playerIdx=', playerIdx, 'teamPlayers=', teamPlayers.length);
      if (playerIdx < teamPlayers.length) {
        e.preventDefault();
        if (isBenched(teamPlayers[playerIdx])) return; // subbed out — Sub in first
        const currentQ = state.questions[state.currentQuestion];
        // Streaks: only +5. Non-streaks: only +10. Shift modifier no longer toggles.
        const points = (currentQ && currentQ.isStreak) ? 5 : 10;
        if (window.DEBUG_KEYS) console.log('[keydown] addPoints', { team, playerIdx, points, currentQ: currentQ ? { num: currentQ.num, isStreak: currentQ.isStreak, isMissing: currentQ.isMissing } : null });
        addPoints(team, playerIdx, points);
      }
    }
  });
}
