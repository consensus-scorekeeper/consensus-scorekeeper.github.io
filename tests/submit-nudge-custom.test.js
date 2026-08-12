// Nudge gating outside Tournament Mode (roster mode left at its 'custom'
// default, which is why this is a separate file from submit-nudge.test.js
// — the mode is read at module load): a publishing key on file marks the
// device as tournament staff and enables the one-click nudge; a casual
// game with neither signal never sees it.

import { describe, it, expect, beforeEach } from 'vitest';

const { state, maybeNudgeSubmit } = await import('../src/main.js');

function completeGame() {
  state.tutorialMode = false;
  state.hasQuestions = true;
  state.questions = Array.from({ length: 3 }, (_, i) => ({ number: i + 1 }));
  state.answeredQuestions = new Set([0, 1, 2]);
  state.currentQuestion = 2;
}
const nudge = () => document.getElementById('submit-nudge');

describe('submit nudge in custom roster mode', () => {
  beforeEach(() => {
    localStorage.removeItem('consensus-tournament-keys-v1');
    state.answeredQuestions = new Set();
    maybeNudgeSubmit(); // clear + re-arm
  });

  it('stays silent for a casual game with no key', () => {
    completeGame();
    maybeNudgeSubmit();
    expect(nudge()).toBeNull();
  });

  it('fires with one-click publish when a key is on file (setup-link flow)', () => {
    localStorage.setItem('consensus-tournament-keys-v1',
      JSON.stringify({ 'linked-open-2026': 'cs_' + 'cd'.repeat(20) }));
    completeGame();
    maybeNudgeSubmit();
    expect(nudge()).toBeTruthy();
    expect(nudge().querySelector('[data-action="nudge-publish-now"]').dataset.slug)
      .toBe('linked-open-2026');
  });
});
