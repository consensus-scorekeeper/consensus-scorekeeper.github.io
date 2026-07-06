// localStorage persistence: state snapshot + the loaded PDF bytes. The PDF is
// kept in a separate key so we can fail gracefully on quota errors (PDFs are
// big enough to push localStorage over the limit on some browsers).
//
// Note: loadState lives in main.js for now because it touches DOM
// (renderRoster, renderGame). The pure data-layer helpers live here.

import { state } from '../state.js';

export const STORAGE_KEY = 'consensus-state-v1';
export const PDF_STORAGE_KEY = 'consensus-pdf-v1';

// Whether the game screen is currently shown. Used by saveState so a refresh
// can restore the user back to the same screen. Reads DOM directly because
// state doesn't carry a "currentScreen" field; Phase 3+ may move this.
export function isGameVisible() {
  const el = document.getElementById('game');
  if (!el) return false;
  if (el.style.display && el.style.display !== 'none') return true;
  return false;
}

export function saveState() {
  // Tutorial sandbox: suppress all persistence so the tutorial doesn't
  // overwrite the moderator's pre-tutorial saved game. Reset on page load.
  if (state.tutorialMode) return;
  try {
    const snapshot = {
      teamA: state.teamA,
      teamB: state.teamB,
      questions: state.questions,
      currentQuestion: state.currentQuestion,
      hasQuestions: state.hasQuestions,
      history: state.history,
      answeredQuestions: [...state.answeredQuestions],
      streakScoring: state.streakScoring,
      packName: state.packName,
      parseIssues: state.parseIssues,
      packDoc: state.packDoc,
      gameActive: isGameVisible(),
      inlinePdfHidden: state.inlinePdfHidden,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (e) {
    console.warn('[persist] saveState failed:', e);
  }
}

export function savePdfBytes(bytes) {
  if (state.tutorialMode) return;
  try {
    // chunked to avoid call-stack limits on String.fromCharCode for large arrays
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    localStorage.setItem(PDF_STORAGE_KEY, btoa(bin));
  } catch (e) {
    console.warn('[persist] savePdfBytes failed (likely quota):', e);
  }
}

export function loadPdfBytes() {
  try {
    const b64 = localStorage.getItem(PDF_STORAGE_KEY);
    if (!b64) return null;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch (e) {
    console.warn('[persist] loadPdfBytes failed:', e);
    return null;
  }
}

export function clearSavedState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PDF_STORAGE_KEY);
  } catch (e) { /* ignore */ }
}

export function clearSavedPdfBytes() {
  if (state.tutorialMode) return;
  try { localStorage.removeItem(PDF_STORAGE_KEY); } catch (e) { /* ignore */ }
}
