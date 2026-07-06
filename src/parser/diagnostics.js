// Pure parse-quality diagnostics. The parsing core and the format adapters
// emit issue records at the point of failure; analyzeQuestions() adds
// whole-pack checks after a parse. Issues are advisory — a pack with issues
// still loads and plays — but they drive the parse report on the setup
// screen, the per-slot warning flags in-game, and the "Format pack" nudge.
//
// Issue shape:
//   { severity: 'error'|'warn', code, message,
//     slot?: number, slots?: [start, end], lineNo?: number, snippet?: string }

import { computeTotalSlots } from './questions.js';

export function makeIssue(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

// Whole-pack checks run after any format's parse.
export function analyzeQuestions(questions, { expectedSlots = 100, source = null } = {}) {
  const issues = [];

  if (questions.length < 10) {
    issues.push(makeIssue('too-few-questions', 'error',
      `Only ${questions.length} question${questions.length === 1 ? '' : 's'} parsed — this doesn't look like a full pack. The game will fall back to numbered tracking.`));
    // The pack won't be used; per-slot checks below would just be noise.
    return issues;
  }

  const totalSlots = computeTotalSlots(questions);
  if (totalSlots !== expectedSlots) {
    issues.push(makeIssue('slot-count-mismatch', 'warn',
      `Parsed ${totalSlots} question slots, expected ${expectedSlots}.`));
  }

  // Numbering gaps: slots in 1..max(expectedSlots, maxNum) covered neither by
  // a question number nor by a streak's range. One issue per contiguous run.
  const maxNum = Math.max(expectedSlots, ...questions.map(q => q.num));
  const covered = new Array(maxNum + 1).fill(false);
  for (const q of questions) {
    covered[q.num] = true;
    if (q.streakRange) {
      for (let s = q.streakRange.start; s <= Math.min(q.streakRange.end, maxNum); s++) covered[s] = true;
    }
  }
  let runStart = null;
  for (let slot = 1; slot <= maxNum + 1; slot++) {
    const gap = slot <= maxNum && !covered[slot];
    if (gap && runStart === null) runStart = slot;
    if (!gap && runStart !== null) {
      const runEnd = slot - 1;
      issues.push(makeIssue('numbering-gap', 'warn',
        runStart === runEnd
          ? `Slot ${runStart} has no parsed question (it will show as skipped).`
          : `Slots ${runStart}–${runEnd} have no parsed question (they will show as skipped).`,
        { slots: [runStart, runEnd] }));
      runStart = null;
    }
  }

  if (questions.every(q => !q.category)) {
    issues.push(makeIssue('no-categories', 'warn',
      'No categories were detected for any question.' +
      (source === 'pdf'
        ? ' The parser identifies category titles by bold text, and the bold-font detection may have failed for this PDF.'
        : '')));
  }

  for (const q of questions) {
    if (!q.streakRange) continue;
    const span = q.streakRange.end - q.streakRange.start + 1;
    const answerCount = q.answer ? q.answer.split(' | ').length : 0;
    if (q.streakRange.end < q.streakRange.start || span > 6 || span > 2 * answerCount) {
      issues.push(makeIssue('streak-span-suspicious', 'warn',
        `Streak at slot ${q.num} spans ${span} slot${span === 1 ? '' : 's'} (slots ${q.streakRange.start}–${q.streakRange.end}) with ${answerCount} accepted answer${answerCount === 1 ? '' : 's'} — the span is inferred from the next question's number and may be wrong.`,
        { slot: q.num }));
    }
    if (answerCount <= 1) {
      issues.push(makeIssue('single-answer-streak', 'warn',
        `Streak at slot ${q.num} has only ${answerCount === 0 ? 'no' : 'one'} accepted answer — its "A:" list may not have parsed.`,
        { slot: q.num }));
    }
  }

  return issues;
}

// Every slot number an issue points at (via slot or a slots range) — used to
// flag sidebar buttons and the question panel in-game.
export function issueSlotSet(issues) {
  const set = new Set();
  for (const issue of issues || []) {
    if (typeof issue.slot === 'number') set.add(issue.slot);
    if (Array.isArray(issue.slots)) {
      for (let s = issue.slots[0]; s <= issue.slots[1]; s++) set.add(s);
    }
  }
  return set;
}

export function summarizeIssues(issues) {
  let errors = 0;
  let warns = 0;
  for (const issue of issues || []) {
    if (issue.severity === 'error') errors++;
    else warns++;
  }
  return { errors, warns };
}

// When a parse looks rough enough that hand-fixing beats playing through it,
// the report panel suggests the Format-pack flow (LLM reformat to the
// canonical .txt format).
export function shouldNudgeFormatPack(issues) {
  const { errors, warns } = summarizeIssues(issues);
  return errors > 0 || warns >= 3;
}
