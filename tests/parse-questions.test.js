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

describe('parseQuestions — category titles with a trailing writer tag', () => {
  // RenWrite-style packs credit writers in the body font at the end of
  // category and answer lines ("Double Jump <JC>"), so a title line isn't
  // uniformly bold and would previously be missed entirely.
  const taggedTitle = (title, tag) =>
    makeLine(`${title} ${tag}`, {
      segments: [{ text: `${title} `, bold: true }, { text: tag, bold: false }],
      isBold: false,
      page: 1,
      y: 700,
    });
  const doc = {
    source: 'test',
    lines: [
      taggedTitle('Double Jump', '<JC>'),
      makeLine('1. First question?', { page: 1, y: 680 }),
      makeLine('A: alpha <IR>', { page: 1, y: 660 }),
      makeLine('2. Second question?', { page: 1, y: 640 }),
      makeLine('A: beta', { page: 1, y: 620 }),
      makeLine('Set of 1: Tagged Bold Title <IR>', { isBold: true, page: 1, y: 600 }),
      makeLine('3. Third question?', { page: 1, y: 580 }),
      makeLine('A: gamma', { page: 1, y: 560 }),
    ],
  };
  const { questions: qs } = parseQuestions(doc);

  it('recognizes the bold-except-tag line as a category', () => {
    expect(qs[0].category).toBe('Double Jump');
    expect(qs[1].category).toBe('Double Jump');
  });
  it('strips the tag from a fully bold title too', () => {
    expect(qs[2].category).toBe('Set of 1: Tagged Bold Title');
  });
  it('strips writer tags from answers', () => {
    expect(qs[0].answer).toBe('alpha');
  });
  it('does not bleed the next tagged title into the prior answer', () => {
    expect(qs[1].answer).toBe('beta');
  });
});

describe('parseQuestions — non-bold prose ending in a tag is not a category', () => {
  const doc = {
    source: 'test',
    lines: [
      makeLine('Set of 2: Real Category', { isBold: true }),
      makeLine('1. Q one?'),
      makeLine('A: one'),
      makeLine('Notes from the editor <IR>'), // fully non-bold — must not become a category
      makeLine('2. Q two?'),
      makeLine('A: two'),
    ],
  };
  const { questions: qs } = parseQuestions(doc);
  it('keeps the previous category', () => {
    expect(qs[1].category).toBe('Set of 2: Real Category');
  });
});

describe('parseQuestions — next title partially eaten by cleanTrailing still strips', () => {
  // "Linked Set of 5" bleeding into the prior answer: cleanTrailing's
  // "Set of N" pattern eats only " Set of 5", stranding "Linked" at the end
  // of the answer unless the title is tried on the uncleaned text first.
  const doc = {
    source: 'test',
    lines: [
      makeLine('Set of 1: Books', { isBold: true }),
      makeLine('1. Which dystopia quotes The Tempest?'),
      makeLine('A: Brave New World'),
      makeLine('Linked Set of 5', { isBold: true }),
      makeLine('2. Practice of map-making?'),
      makeLine('A: cartography'),
    ],
  };
  const { questions: qs } = parseQuestions(doc);
  it('strips the full next-category title from the answer', () => {
    expect(qs[0].answer).toBe('Brave New World');
  });
  it('assigns the new category to the following question', () => {
    expect(qs[1].category).toBe('Linked Set of 5');
  });
});

describe('parseQuestions — Gradwrite-style Pyramid (bare number + unnumbered parts)', () => {
  // A Pyramid is a Jackpot-style clue chain written as a bare "11." line
  // above unnumbered "Part N:" lines, with the next question at 14 — the
  // pack's numbering gives the pyramid slots 11–13. The parts must be split
  // across the gap (last slot absorbs the extras) and all share the answer.
  const doc = buildDoc([
    { text: 'Set of 1: Warmup', isBold: true },
    { text: '10. Who wrote Twilight?' },
    { text: 'A: Stephanie Meyer' },
    { text: 'Pyramid', isBold: true },
    { text: '11.' },
    { text: 'Part 1: Hardest clue about a Norse god?' },
    { text: 'Part 2: This god fights Garmr at Ragnarok.' },
    { text: 'Part 3: This god lost a hand to Fenrir.' },
    { text: 'Part 4: Tuesday is named after him.' },
    { text: 'A: Tyr' },
    { text: 'Set of 1: After', isBold: true },
    { text: '14. Largest US county by population?' },
    { text: 'A: Los Angeles County' },
  ]);
  const { questions: qs } = parseQuestions(doc);

  it('covers slots 11-13 with the Pyramid category', () => {
    const nums = qs.map((q) => q.num);
    expect(nums).toEqual([10, 11, 12, 13, 14]);
    for (const n of [11, 12, 13]) expect(qs.find((q) => q.num === n).category).toBe('Pyramid');
  });
  it('splits parts one per slot, last slot absorbing the extras', () => {
    expect(qs.find((q) => q.num === 11).question).toBe('Part 1: Hardest clue about a Norse god?');
    expect(qs.find((q) => q.num === 12).question).toBe('Part 2: This god fights Garmr at Ragnarok.');
    expect(qs.find((q) => q.num === 13).question).toBe(
      'Part 3: This god lost a hand to Fenrir. Part 4: Tuesday is named after him.');
  });
  it('shares the answer across all pyramid slots', () => {
    for (const n of [11, 12, 13]) expect(qs.find((q) => q.num === n).answer).toBe('Tyr');
  });
  it('does not bleed the Pyramid title into the previous answer', () => {
    expect(qs.find((q) => q.num === 10).answer).toBe('Stephanie Meyer');
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
