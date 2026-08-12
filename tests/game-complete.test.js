// isGameComplete (state.js) — the heuristic behind the scorekeeper's
// end-of-game "Submit Results?" nudge. It must fire when a game is truly
// wrapped up, stay quiet mid-game, and re-arm cleanly is main.js's job.

import { describe, it, expect, beforeEach } from 'vitest';
import { state, isGameComplete } from '../src/main.js';

function loadGame(slots) {
  state.hasQuestions = true;
  state.questions = Array.from({ length: slots }, (_, i) => ({ number: i + 1 }));
  state.answeredQuestions = new Set();
  state.currentQuestion = 0;
}

describe('isGameComplete', () => {
  beforeEach(() => loadGame(5));

  it('is false with no pack loaded', () => {
    state.hasQuestions = false;
    state.questions = [];
    expect(isGameComplete()).toBe(false);
  });

  it('is false mid-game', () => {
    state.answeredQuestions = new Set([0, 1]);
    state.currentQuestion = 2;
    expect(isGameComplete()).toBe(false);
  });

  it('is true when every slot is resolved', () => {
    state.answeredQuestions = new Set([0, 1, 2, 3, 4]);
    state.currentQuestion = 2; // even while reviewing an earlier question
    expect(isGameComplete()).toBe(true);
  });

  it('is true on the scored final slot even with earlier dead questions', () => {
    state.answeredQuestions = new Set([0, 2, 4]); // 1 and 3 went dead
    state.currentQuestion = 4;
    expect(isGameComplete()).toBe(true);
  });

  it('is false on the final slot before it is scored', () => {
    state.answeredQuestions = new Set([0, 1, 2, 3]);
    state.currentQuestion = 4;
    expect(isGameComplete()).toBe(false);
  });

  it('is false when the last slot is scored early mid-pack navigation', () => {
    state.answeredQuestions = new Set([4]);
    state.currentQuestion = 1; // jumped back to continue the game
    expect(isGameComplete()).toBe(false);
  });
});
