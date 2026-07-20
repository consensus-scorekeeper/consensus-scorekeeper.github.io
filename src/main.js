// Entry point. Pulls together state + all UI modules, wires the static
// data-action click dispatcher, and triggers loadState() at the end so
// any restored session takes effect after every other module is ready.
//
// Subsequent layers:
//   state.js                — singleton + reducers + subscribe()
//   util/{escape,csv}.js    — pure helpers
//   parser/{zip,pdf-text,questions}.js — pure PDF parsing
//   game/{streaks,jailbreak,categories,persistence}.js — derived data + IO
//   loader.js               — orchestrates parsePdf / processZipBuffer
//   ui/*.js                 — DOM-coupled modules; each owns its own setup()
//
// renderGame is wired as the single state-change subscriber inside
// setupGameScreen() — see ui/game.js. main.js does not subscribe directly.

import {
  state,
  hasGameInProgress,
  addPoints,
  clearPlayerPoints,
  clearCurrentQuestion,
  resetStreak,
  applyCustomAward as applyCustomAwardReducer,
  reorderPlayer,
  undoLast,
} from './state.js';
import { rebuildJailbreakLocks } from './game/jailbreak.js';
import { rebuildStreakGroups } from './game/streaks.js';
import { getInitials, getAnsweredBy, getSplitPair, getCategoryRunSize } from './game/categories.js';
import { STORAGE_KEY, saveState, savePdfBytes, loadPdfBytes, clearSavedState } from './game/persistence.js';
import { addPlayer, removePlayer, renderRoster, setupSetupScreen, setTeamNameField, toggleRosterMode } from './ui/setup.js';
import { parsePdf, parseDocx, parseTextFile, processZipBuffer, handleZipUpload } from './loader.js';
import { readZip, looksLikePdfOrZip } from './parser/zip.js';
import { cleanTrailing, extractRichRange, richToHtml, parseQuestions } from './parser/questions.js';
import {
  padQuestionsToSlots,
  startGame,
  backToSetup,
  renderGame,
  nextQuestion,
  prevQuestion,
  skipQuestion,
  goToQuestion,
  setupGameScreen,
} from './ui/game.js';
import { applyCustomAward, setupDevTools, reparseCurrentPdf as reparsePdfImpl } from './ui/dev-tools.js';
import { setupKeybinds } from './ui/keybinds.js';
import {
  createAndJoinRoom, closeRoom, copyPlayerLink, copySpectatorLink,
  toggleHold, unassignPhone, assignJoinerToTeam,
} from './ui/room.js';
import { escapeHtml, csvEscape } from './util/escape.js';
import { buildResultsCsv, buildResultsFilename } from './util/csv.js';
import { downloadTextFile } from './ui/download.js';
import { setupSplitters } from './ui/splitter.js';
import {
  viewPack,
  closePdfViewer,
  syncInlinePdfToQuestion,
  toggleInlinePdf,
  pdfPagePrev,
  pdfPageNext,
  inlinePdfPrev,
  inlinePdfNext,
  setupPdfViewer,
} from './ui/pdf-viewer.js';
import { pushScoreboardUpdate, popOutScoreboard } from './ui/scoreboard-popout.js';
import { setupPackBrowser } from './ui/pack-browser.js';
import { startTutorialGame } from './ui/tutorial.js';
import { renderParseReport } from './ui/parse-report.js';
import { setupRosterManager, rosterManagerActions } from './ui/roster-manager.js';

// ==================== UI INIT ====================
setupSetupScreen();
setupGameScreen();
setupDevTools();
setupKeybinds({ nextQuestion: () => nextQuestion(), prevQuestion: () => prevQuestion() });
setupSplitters();
setupPdfViewer();
setupPackBrowser();
setupRosterManager();

// File picker on the setup screen — uploads a .pdf, .docx, or .txt pack,
// or a .zip holding any mix of those. The non-PDF formats are text-only
// (no inline PDF viewer).
document.getElementById('pdf-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.zip')) {
    await handleZipUpload(file);
  } else if (lower.endsWith('.docx')) {
    await parseDocx(await file.arrayBuffer(), file.name);
  } else if (lower.endsWith('.txt')) {
    await parseTextFile(await file.text(), file.name);
  } else {
    await parsePdf(await file.arrayBuffer(), file.name);
  }
});

// Reparse needs padQuestionsToSlots + renderGame, both of which live in
// ui/game.js. Inject them so dev-tools doesn't need to import ui/game.
const reparseCurrentPdf = () => reparsePdfImpl({ padQuestionsToSlots, renderGame });

function clearAndReload() {
  if (!confirm('Clear all saved progress and reload?')) return;
  clearSavedState();
  location.reload();
}

// Keep the setup screen's session buttons honest: Resume Game only when
// restored state actually has progress to return to, Clear saved game only
// when there is a saved session to clear.
function updateSessionButtons() {
  const resumeBtn = document.getElementById('resume-btn');
  if (resumeBtn) resumeBtn.style.display = hasGameInProgress() ? '' : 'none';
  let hasSave = false;
  try { hasSave = !!localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
  const clearBtn = document.getElementById('clear-save-btn');
  if (clearBtn) clearBtn.style.display = hasSave ? '' : 'none';
}

// Re-enter the game screen with the restored (or backgrounded) session as
// it stands — the counterpart of Start Game's reset.
function resumeGame() {
  if (!hasGameInProgress()) return;
  document.getElementById('setup').style.display = 'none';
  document.getElementById('game').style.display = 'block';
  renderGame();
}

// Start Game resets scores/history, so guard it when that would discard a
// game in progress. The confirm lives here (not in startGame) so the
// tutorial's programmatic startGame() never prompts.
function startGameGuarded() {
  if (hasGameInProgress()
      && !confirm('A game is already in progress. Start a new game? Its scores and history will be discarded (use Resume Game to continue it).')) {
    return;
  }
  startGame();
}

// Trigger a CSV download. The CSV builder is pure (util/csv.js); the BOM
// prefix keeps Excel happy with UTF-8 content.
function exportCsv() {
  const csv = buildResultsCsv(state);
  downloadTextFile(buildResultsFilename(state), '﻿' + csv, 'text/csv;charset=utf-8;');
}

// loadState restores the last session's data from localStorage but always
// lands on the setup screen — re-entering the game is an explicit Resume
// Game click, never a side effect of a page refresh. Lives here because it
// does both data restore (state mutation) and post-restore DOM updates
// (renderRoster, session buttons), which would otherwise cross module
// boundaries.
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw);
    Object.assign(state.teamA, snap.teamA || {});
    Object.assign(state.teamB, snap.teamB || {});
    state.questions = snap.questions || [];
    state.currentQuestion = snap.currentQuestion || 0;
    state.hasQuestions = !!snap.hasQuestions;
    state.history = snap.history || [];
    state.answeredQuestions = new Set(snap.answeredQuestions || []);
    // Migrate v1 streakScoring (single scorer per streak: { team, playerIndex, globalPlayerIdx, totalPoints })
    // to v2 (per-team buckets: { a?: {playerIndex, totalPoints}, b?: ... }).
    const ss = snap.streakScoring || {};
    for (const k of Object.keys(ss)) {
      const v = ss[k];
      if (v && typeof v === 'object' && 'team' in v && 'totalPoints' in v) {
        ss[k] = { [v.team]: { playerIndex: v.playerIndex, totalPoints: v.totalPoints } };
      }
    }
    state.streakScoring = ss;
    state.packName = snap.packName || null;
    state.parseIssues = snap.parseIssues || [];
    state.packDoc = snap.packDoc || null;
    state.inlinePdfHidden = !!snap.inlinePdfHidden;
    rebuildStreakGroups();
    renderParseReport();

    const pdfBytes = loadPdfBytes();
    if (pdfBytes) state.pdfBytes = pdfBytes;

    // Restore setup UI fields regardless of game state. The team-name <select>
    // is populated from preset rosters; setTeamSelectValue handles the case
    // where a saved name doesn't match any preset (older saves, tutorial sandboxes).
    setTeamNameField('a', state.teamA.name || 'Team A');
    setTeamNameField('b', state.teamB.name || 'Team B');
    renderRoster('a');
    renderRoster('b');
    if (state.packName) {
      const statusEl = document.getElementById('pdf-status');
      statusEl.textContent = `Restored "${state.packName}" from previous session.`;
      statusEl.className = 'pdf-status success';
    }
    return true;
  } catch (e) {
    console.warn('[persist] loadState failed:', e);
    return false;
  } finally {
    updateSessionButtons();
  }
}

// ==================== ACTION DISPATCH ====================
// Single delegated click handler for everything index.html flags with
// data-action="…". Buttons rendered dynamically (player panels, sidebar,
// roster, streak status) are handled by their own delegated listeners
// inside the relevant ui/* setup functions; this dispatcher covers the
// static buttons that exist in index.html itself.
const ACTION_HANDLERS = {
  'add-player': (btn) => addPlayer(btn.dataset.team),
  'start-game': () => startGameGuarded(),
  'resume-game': () => resumeGame(),
  'start-tutorial': () => startTutorialGame(),
  'clear-and-reload': () => clearAndReload(),
  'toggle-roster-mode': () => toggleRosterMode(),
  'pdf-page-prev': () => pdfPagePrev(),
  'pdf-page-next': () => pdfPageNext(),
  'close-pdf-viewer': () => closePdfViewer(),
  'pop-out-scoreboard': () => popOutScoreboard(),
  'room-create': () => createAndJoinRoom(),
  'room-close': () => closeRoom(),
  'room-copy-player': () => copyPlayerLink(),
  'room-copy-spectator': () => copySpectatorLink(),
  'room-hold': () => toggleHold(),
  'room-unassign': (btn) => unassignPhone(btn.dataset.name),
  'room-join-team': (btn) => assignJoinerToTeam(btn.dataset.name, btn.dataset.team),
  'apply-custom-award': () => applyCustomAward(),
  'prev-question': () => prevQuestion(),
  'skip-question': () => skipQuestion(),
  'next-question': () => nextQuestion(),
  'inline-pdf-prev': () => inlinePdfPrev(),
  'inline-pdf-next': () => inlinePdfNext(),
  'view-pack': () => viewPack(),
  'undo-last': () => undoLast(),
  'toggle-inline-pdf': () => toggleInlinePdf(),
  'export-csv': () => exportCsv(),
  'reparse-current-pdf': () => reparseCurrentPdf(),
  'back-to-setup': () => { backToSetup(); updateSessionButtons(); },
  ...rosterManagerActions,
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const handler = ACTION_HANDLERS[btn.dataset.action];
  if (handler) handler(btn);
});

// Restore previous session if any. Runs at the end so all DOM elements,
// listeners, and reducers are wired up before render fires.
loadState();

// ==================== ES MODULE EXPORTS (for tests) ====================
// Tests import from main.js to verify the full integration surface.
// Each export is a pure re-export of an already-imported binding.
export {
  state,
  // pure
  cleanTrailing,
  extractRichRange,
  richToHtml,
  parseQuestions,
  escapeHtml,
  csvEscape,
  getInitials,
  // game logic
  getSplitPair,
  getCategoryRunSize,
  getAnsweredBy,
  rebuildStreakGroups,
  padQuestionsToSlots,
  rebuildJailbreakLocks,
  // zip / pdf
  readZip,
  looksLikePdfOrZip,
  // state mutations
  addPoints,
  undoLast,
  clearPlayerPoints,
  clearCurrentQuestion,
  resetStreak,
  applyCustomAward,
  reorderPlayer,
  // persistence
  saveState,
  loadState,
  savePdfBytes,
  loadPdfBytes,
  clearSavedState,
  // export
  exportCsv,
  // setup / lifecycle
  addPlayer,
  removePlayer,
  startGame,
  backToSetup,
};
