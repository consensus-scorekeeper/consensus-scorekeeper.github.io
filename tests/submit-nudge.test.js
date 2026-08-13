// The end-of-game submit nudge (main.js maybeNudgeSubmit): appears once
// when the game completes in Tournament Mode, offers one-click Publish
// now when a publishing key pins down the tournament, falls back to the
// form button otherwise, dismisses, and re-arms on a new game. Also the
// Submit Results entry point itself: with a key pinning down the
// tournament it publishes directly (fetch mocked — never the live
// relay), falling back to the prefilled modal on refusal.
//
// Roster mode is read at module load, so it must be persisted BEFORE
// main.js is imported — hence the dynamic import below. Keys and the
// last-submitted slug are read per nudge, so tests vary those freely.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

localStorage.setItem('consensus-roster-mode-v1', 'preset');
const { state, maybeNudgeSubmit, submitResults } = await import('../src/main.js');

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
    // the full form stays reachable — via the explicit Review… action
    // (submit-results itself now direct-publishes when a key is on file)
    const review = nudge().querySelector('[data-action="submit-review"]');
    expect(review).toBeTruthy();
    expect(review.dataset.slug).toBe('x-open-2026');
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

describe('Submit Results with a key on file', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    localStorage.setItem('consensus-tournament-keys-v1',
      JSON.stringify({ 'x-open-2026': KEY }));
    localStorage.removeItem('consensus-last-submit-slug-v1');
    completeGame();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    const el = nudge();
    if (el) el.remove();
  });

  it('publishes directly — no modal, key riding along', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        verified: true,
        previewUrl: 'https://consensus-scorekeeper.github.io/tournaments/preview.html?slug=x-open-2026&preview=42',
      }),
    }));
    await submitResults();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toContain('/submit');
    const body = JSON.parse(init.body);
    expect(body.slug).toBe('x-open-2026');
    expect(body.key).toBe(KEY);
    // the modal was never even built…
    expect(document.getElementById('submission-modal')).toBeNull();
    // …and the outcome lands in the toast + last-slug memory
    expect(nudge().textContent).toContain('Published');
    expect(localStorage.getItem('consensus-last-submit-slug-v1')).toBe('x-open-2026');
  });

  it('falls back to the prefilled modal when the relay refuses', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({ error: 'CSV did not parse' }),
    }));
    await submitResults();
    const modal = document.getElementById('submission-modal');
    expect(modal).toBeTruthy();
    expect(modal.classList.contains('open')).toBe(true);
    expect(modal.querySelector('#sf-slug').value).toBe('x-open-2026');
    expect(nudge()).toBeNull();
    modal.classList.remove('open');
  });
});
