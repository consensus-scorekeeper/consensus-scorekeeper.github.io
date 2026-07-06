import { describe, it, expect } from 'vitest';
import { parseQuestions, computeTotalSlots } from '../src/parser/questions.js';
import {
  analyzeQuestions,
  issueSlotSet,
  summarizeIssues,
  shouldNudgeFormatPack,
} from '../src/parser/diagnostics.js';
import { makeLine } from '../src/parser/rich-doc.js';

function buildDoc(spec) {
  return {
    source: 'test',
    lines: spec.map((s) => makeLine(s.text, { isBold: !!s.isBold })),
  };
}

// A synthetic full pack: `count` plain questions numbered from 1, all in one
// category.
function fullPack(count, { category = 'Set: Stuff' } = {}) {
  const qs = [];
  for (let n = 1; n <= count; n++) {
    qs.push({ num: n, question: `Q${n}`, answer: `A${n}`, category, streakRange: null });
  }
  return qs;
}

describe('analyzeQuestions', () => {
  it('flags too-few-questions as an error and skips per-slot noise', () => {
    const issues = analyzeQuestions(fullPack(3));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('too-few-questions');
    expect(issues[0].severity).toBe('error');
  });

  it('reports nothing for a clean full pack', () => {
    expect(analyzeQuestions(fullPack(100))).toEqual([]);
  });

  it('flags slot-count-mismatch and numbering gaps', () => {
    const issues = analyzeQuestions(fullPack(12));
    const codes = issues.map(i => i.code);
    expect(codes).toContain('slot-count-mismatch');
    const gap = issues.find(i => i.code === 'numbering-gap');
    expect(gap.slots).toEqual([13, 100]);
  });

  it('reports one gap issue per contiguous run', () => {
    const qs = fullPack(100).filter(q => q.num !== 5 && q.num !== 6 && q.num !== 40);
    const gaps = analyzeQuestions(qs).filter(i => i.code === 'numbering-gap');
    expect(gaps.map(g => g.slots)).toEqual([[5, 6], [40, 40]]);
  });

  it('treats streak ranges as covering their slots', () => {
    // 96 single questions + one streak spanning slots 11-14 = 100 slots.
    const qs = fullPack(100).filter(q => q.num < 11 || q.num > 14);
    qs.push({
      num: 11, question: 'Streak', answer: 'a | b | c | d | e | f | g | h',
      category: 'Streak', streakRange: { start: 11, end: 14 },
    });
    expect(computeTotalSlots(qs)).toBe(100);
    expect(analyzeQuestions(qs)).toEqual([]);
  });

  it('flags no-categories, with a bold-font hint for PDFs', () => {
    const qs = fullPack(100, { category: null });
    const generic = analyzeQuestions(qs).find(i => i.code === 'no-categories');
    expect(generic).toBeDefined();
    expect(generic.message).not.toMatch(/bold/);
    const pdf = analyzeQuestions(qs, { source: 'pdf' }).find(i => i.code === 'no-categories');
    expect(pdf.message).toMatch(/bold/);
  });

  it('flags suspicious streak spans', () => {
    const qs = fullPack(100).filter(q => q.num < 50 || q.num > 60);
    qs.push({
      num: 50, question: 'Streak', answer: 'a | b',
      category: 'Streak', streakRange: { start: 50, end: 60 },
    });
    const issue = analyzeQuestions(qs).find(i => i.code === 'streak-span-suspicious');
    expect(issue).toBeDefined();
    expect(issue.slot).toBe(50);
  });

  it('flags single-answer streaks', () => {
    const qs = fullPack(100).filter(q => q.num !== 20 && q.num !== 21);
    qs.push({
      num: 20, question: 'Streak', answer: 'only one',
      category: 'Streak', streakRange: { start: 20, end: 21 },
    });
    const issue = analyzeQuestions(qs).find(i => i.code === 'single-answer-streak');
    expect(issue).toBeDefined();
    expect(issue.slot).toBe(20);
  });
});

describe('parseQuestions issue emission', () => {
  it('emits duplicate-number when a number repeats', () => {
    const { questions, issues } = parseQuestions(buildDoc([
      { text: 'Set of 2: Dupes', isBold: true },
      { text: '5. First version?' },
      { text: 'A: one' },
      { text: '5. Second version?' },
      { text: 'A: two' },
    ]));
    expect(questions).toHaveLength(1);
    const issue = issues.find(i => i.code === 'duplicate-number');
    expect(issue.slot).toBe(5);
    expect(issue.snippet).toContain('Second version');
  });

  it('emits unparsed-answer when A: has no content', () => {
    const { issues } = parseQuestions(buildDoc([
      { text: 'Set of 1: X', isBold: true },
      { text: '7. A question?' },
      { text: 'A:' },
    ]));
    const issue = issues.find(i => i.code === 'unparsed-answer');
    expect(issue.slot).toBe(7);
  });

  it('emits jackpot-unresolved when a clue never gets an answer', () => {
    const { issues } = parseQuestions(buildDoc([
      { text: 'Jackpot', isBold: true },
      { text: '14. Clue with no answer anywhere.' },
    ]));
    const issue = issues.find(i => i.code === 'jackpot-unresolved');
    expect(issue.severity).toBe('error');
    expect(issue.slot).toBe(14);
  });

  it('emits out-of-range-number for line-start numbers above 100', () => {
    const { questions, issues } = parseQuestions(buildDoc([
      { text: 'Set of 1: X', isBold: true },
      { text: '101. Beyond the pack?' },
      { text: 'A: nope' },
    ]));
    expect(questions).toHaveLength(0);
    expect(issues.some(i => i.code === 'out-of-range-number')).toBe(true);
  });
});

describe('issue helpers', () => {
  const issues = [
    { code: 'a', severity: 'error', message: 'm', slot: 4 },
    { code: 'b', severity: 'warn', message: 'm', slots: [10, 12] },
    { code: 'c', severity: 'warn', message: 'm' },
  ];

  it('issueSlotSet expands slot and slots ranges', () => {
    expect([...issueSlotSet(issues)].sort((x, y) => x - y)).toEqual([4, 10, 11, 12]);
  });

  it('summarizeIssues counts by severity', () => {
    expect(summarizeIssues(issues)).toEqual({ errors: 1, warns: 2 });
  });

  it('shouldNudgeFormatPack triggers on any error or 3+ warns', () => {
    expect(shouldNudgeFormatPack([])).toBe(false);
    expect(shouldNudgeFormatPack([{ severity: 'warn' }])).toBe(false);
    expect(shouldNudgeFormatPack([{ severity: 'error' }])).toBe(true);
    expect(shouldNudgeFormatPack([{ severity: 'warn' }, { severity: 'warn' }, { severity: 'warn' }])).toBe(true);
  });
});
