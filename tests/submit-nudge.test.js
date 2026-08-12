// The end-of-game submit nudge (main.js maybeNudgeSubmit): appears once
// when the game completes in Tournament Mode, offers one-click Publish
// now when a publishing key pins down the tournament, falls back to the
// form button otherwise, dismisses, and re-arms on a new game.
//
// Roster mode is read at module load, so it must be persisted BEFORE
// main.js is imported — hence the dynamic import below. Keys and the
// last-submitted slug are read per nudge, so tests vary those freely.
// Publish now itself is never clicked here (it would call the live
// relay); the network path is the same submitResults the modal uses.

import { describe, it, expect, beforeEach } from 'vitest';

localStorage.setItem('consensus-roster-mode-v1', 'preset');
const { state, maybeNudgeSubmit } = await import('../src/main.js');

const KEY = 'cs_' + 'ab'.repeat(20);

function completeGame() {
  state.tutorialMode = false;
  state.hasQuestions = true;
  state.questions = Array.from({ length: 3 }, (_, i) => ({ number: i + 1 }));
  state.answeredQuestions = new Set([0, 1, 2]);
  state.currentQuestion = 2;
}
function freshGame() {
  state.answeredQuestions = new Set();
  state.currentQuestion = 0;
}
const nudge = () => document.getElementById('submit-nudge');

describe('end-of-game submit nudge', () => {
  beforeEach(() => {
    localStorage.removeItem('consensus-tournament-keys-v1');
    localStorage.removeItem('consensus-last-submit-slug-v1');
    freshGame();
    maybeNudgeSubmit(); // clears any leftover + re-arms
  });

  it('appears once when the game completes, with the form button by default', () => {
    completeGame();
    maybeNudgeSubmit();
    expect(nudge()).toBeTruthy();
    expect(nudge().querySelector('[data-action="submit-results"]')).toBeTruthy();
    expect(nudge().querySelector('[data-action="nudge-publish-now"]')).toBeNull();
  });

  it('offers one-click Publish now when a key pins down the tournament', () => {
    localStorage.setItem('consensus-tournament-keys-v1', JSON.stringify({ 'x-open-2026': KEY }));
    completeGame();
    maybeNudgeSubmit();
    const btn = nudge().querySelector('[data-action="nudge-publish-now"]');
    expect(btn).toBeTruthy();
    expect(btn.dataset.slug).toBe('x-open-2026');
    expect(nudge().textContent).toContain('x-open-2026');
    // the full form stays reachable
    expect(nudge().querySelector('[data-action="submit-results"]')).toBeTruthy();
  });

  it('does not reappear after dismissal until a new game completes', () => {
    completeGame();
    maybeNudgeSubmit();
    nudge().remove(); // what the dismiss action does
    maybeNudgeSubmit();
    expect(nudge()).toBeNull();

    freshGame();          // new game starts → completeness drops
    maybeNudgeSubmit();   // re-arms
    completeGame();
    maybeNudgeSubmit();
    expect(nudge()).toBeTruthy();
  });

  it('never fires during the tutorial', () => {
    completeGame();
    state.tutorialMode = true;
    maybeNudgeSubmit();
    expect(nudge()).toBeNull();
  });
});
