import { describe, it, expect } from 'vitest';
import { parseQuestions } from '../src/main.js';
import { makeLine } from '../src/parser/rich-doc.js';

// Build a synthetic RichDoc from a list of {text, isBold} lines, mirroring
// what the pdf adapter produces so the assertions exercise the same parser
// code paths real PDFs hit.
function buildDoc(spec) {
  return {
    source: 'test',
    lines: spec.map((s, i) =>
      makeLine(s.text, { isBold: !!s.isBold, page: s.page || 1, y: s.y || (700 - i * 20) })),
  };
}

describe('parseQuestions — basic Set of 4 category', () => {
  const doc = buildDoc([
    { text: 'Set of 4: Famous Authors', isBold: true },
    { text: '1. Who wrote Hamlet?' },
    { text: 'A: Shakespeare' },
    { text: '2. Who wrote 1984?' },
    { text: 'A: Orwell' },
    { text: '3. Who wrote Beloved?' },
    { text: 'A: Toni Morrison' },
    { text: '4. Who wrote Ulysses?' },
    { text: 'A: Joyce' },
  ]);
  const { questions: qs } = parseQuestions(doc);

  it('finds 4 questions', () => expect(qs).toHaveLength(4));
  it('numbers them 1..4', () => expect(qs.map((q) => q.num)).toEqual([1, 2, 3, 4]));
  it('captures question text without leading "N."', () => {
    expect(qs[0].question).toBe('Who wrote Hamlet?');
    expect(qs[3].question).toBe('Who wrote Ulysses?');
  });
  it('captures answers', () => {
    expect(qs[0].answer).toBe('Shakespeare');
    expect(qs[2].answer).toBe('Toni Morrison');
  });
  it('attaches the category to each question', () => {
    for (const q of qs) expect(q.category).toBe('Set of 4: Famous Authors');
  });
  it('numbers posInCategory 1..4', () => {
    expect(qs.map((q) => q.posInCategory)).toEqual([1, 2, 3, 4]);
  });
  it('does not mark them as streak', () => {
    for (const q of qs) expect(q.streakRange).toBeNull();
  });
});

describe('parseQuestions — streak round', () => {
  const doc = buildDoc([
    { text: 'Streak: US Capitals', isBold: true },
    { text: '85. Name as many US state capitals as possible.' },
    { text: 'A: Albany' },
    { text: 'A: Boston' },
    { text: 'A: Sacramento' },
    { text: 'Set of 4: Next Category', isBold: true },
    { text: '90. Different question.' },
    { text: 'A: Foo' },
  ]);
  const { questions: qs } = parseQuestions(doc);

  it('finds the streak question', () => {
    const streak = qs.find((q) => q.num === 85);
    expect(streak).toBeDefined();
    expect(streak.streakRange).toEqual({ start: 85, end: 89 });
    expect(streak.category).toBe('Streak: US Capitals');
  });
  it('joins multiple A: answers with " | "', () => {
    const streak = qs.find((q) => q.num === 85);
    expect(streak.answer).toBe('Albany | Boston | Sacramento');
  });
});

describe('parseQuestions — splits', () => {
  const doc = buildDoc([
    { text: 'Splits:', isBold: false },
    { text: 'Gothic Literature', isBold: true },
    { text: '50. Who wrote Frankenstein?' },
    { text: 'A: Mary Shelley' },
    { text: '51. Who wrote Dracula?' },
    { text: 'A: Bram Stoker' },
    { text: 'Mountaineering', isBold: true },
    { text: '52. Highest peak in the world?' },
    { text: 'A: Everest' },
    { text: '53. K2 is in which range?' },
    { text: 'A: Karakoram' },
  ]);
  const { questions: qs } = parseQuestions(doc);

  it('labels first sub-category as "Splits 1: ..."', () => {
    expect(qs[0].category).toBe('Splits 1: Gothic Literature');
    expect(qs[1].category).toBe('Splits 1: Gothic Literature');
  });
  it('labels second sub-category as "Splits 2: ..."', () => {
    expect(qs[2].category).toBe('Splits 2: Mountaineering');
    expect(qs[3].category).toBe('Splits 2: Mountaineering');
  });
});

describe('parseQuestions — captures category instructions', () => {
  const doc = buildDoc([
    { text: 'Set of 3: Before and After', isBold: true },
    { text: 'Each answer is two phrases joined by a shared word.' },
    { text: '60. Q text' },
    { text: 'A: Answer text' },
  ]);
  const { questions: qs } = parseQuestions(doc);
  it('attaches the prose between category title and Q1 as instructions', () => {
    expect(qs[0].categoryInstructions).toBe('Each answer is two phrases joined by a shared word.');
  });
});

describe('parseQuestions — rejects mid-sentence "N." matches', () => {
  // Critical regression: in the parser comment, "secant of 5 pi over 3." inside
  // a question must NOT be matched as Q3. The fix is the isLineStart() check
  // against lineStartPositions.
  const doc = buildDoc([
    { text: 'Set of 4: Math', isBold: true },
    { text: '1. What is the secant of 5 pi over 3.' },
    { text: 'A: 2' },
    { text: '2. What is sin of pi?' },
    { text: 'A: 0' },
  ]);
  const { questions: qs } = parseQuestions(doc);
  it('does not produce a spurious Q3 from "over 3."', () => {
    expect(qs.map((q) => q.num)).toEqual([1, 2]);
  });
});

describe('parseQuestions — stores page + y from rich segment', () => {
  const doc = buildDoc([
    { text: 'Set of 1: P', isBold: true, page: 2, y: 500 },
    { text: '1. Q?', page: 2, y: 480 },
    { text: 'A: A', page: 2, y: 470 },
  ]);
  const { questions: qs } = parseQuestions(doc);
  it('records pageNum and yPos', () => {
    expect(qs[0].pageNum).toBe(2);
    expect(qs[0].yPos).toBe(480);
  });
});
