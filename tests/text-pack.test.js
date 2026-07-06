import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseTextPack } from '../src/parser/text-pack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parseTextPack — basic category + questions', () => {
  const { questions: qs } = parseTextPack(
    `Set of 4: Famous Authors
1. Who wrote Hamlet?
A: Shakespeare
2. Who wrote 1984?
A: Orwell
3. Who wrote Beloved?
A: Toni Morrison
4. Who wrote Ulysses?
A: Joyce
`
  );

  it('finds 4 questions', () => expect(qs).toHaveLength(4));
  it('captures question text and answer', () => {
    expect(qs[0].question).toBe('Who wrote Hamlet?');
    expect(qs[0].answer).toBe('Shakespeare');
    expect(qs[3].answer).toBe('Joyce');
  });
  it('attaches the category', () => {
    for (const q of qs) expect(q.category).toBe('Set of 4: Famous Authors');
  });
});

describe('parseTextPack — accepts indented "a." answer marker', () => {
  const { questions: qs } = parseTextPack(
    `Set of 2: Misc
1. Q one?
    a. one
2. Q two?
    a. two
`
  );
  it('parses both questions', () => {
    expect(qs.map(q => q.num)).toEqual([1, 2]);
    expect(qs.map(q => q.answer)).toEqual(['one', 'two']);
  });
});

describe('parseTextPack — streak with multiple A: answers', () => {
  const { questions: qs } = parseTextPack(
    `Streak
10. Name up to 8 cities.
A: Boston
A: Chicago
A: New York

Set of 1: Next
14. Hello?
A: hi
`
  );
  const streak = qs.find(q => q.num === 10);
  it('captures the streak question', () => expect(streak).toBeDefined());
  it('joins multiple A: into one answer string', () => {
    expect(streak.answer).toBe('Boston | Chicago | New York');
  });
  it('sets streakRange spanning to the next question', () => {
    expect(streak.streakRange).toEqual({ start: 10, end: 13 });
  });
});

describe('parseTextPack — jackpot answer propagation', () => {
  const { questions: qs } = parseTextPack(
    `Jackpot
14. Clue 1.
15. Clue 2.
16. Clue 3.
17. Clue 4.
A: final
`
  );
  it('propagates the final answer to earlier clues', () => {
    expect(qs.map(q => q.answer)).toEqual(['final', 'final', 'final', 'final']);
  });
});

describe('parseTextPack — splits', () => {
  const { questions: qs } = parseTextPack(
    `Splits: Gothic & Mountains
Gothic Literature
50. Who wrote Frankenstein?
A: Mary Shelley
51. Who wrote Dracula?
A: Bram Stoker
Mountaineering
52. Highest peak?
A: Everest
53. K2 range?
A: Karakoram
`
  );
  it('labels sub-categories as Splits 1 / Splits 2', () => {
    expect(qs[0].category).toBe('Splits 1: Gothic Literature');
    expect(qs[2].category).toBe('Splits 2: Mountaineering');
  });
});

describe('parseTextPack — instructions captured per category', () => {
  const { questions: qs } = parseTextPack(
    `Set of 3: Before and After
Each answer is two phrases joined by a shared word.
60. Q text
A: Answer text
`
  );
  it('attaches prose between category and first Q as instructions', () => {
    expect(qs[0].categoryInstructions).toBe('Each answer is two phrases joined by a shared word.');
  });
});

describe('parseTextPack — full sample_txt_pack.txt fixture', () => {
  const text = readFileSync(join(__dirname, '..', 'assets', 'sample_txt_pack.txt'), 'utf8');
  const { questions: qs } = parseTextPack(text);

  it('parses every numbered question + both streaks', () => {
    const nums = qs.map(q => q.num);
    expect(nums).toContain(1);
    expect(nums).toContain(10);
    expect(nums).toContain(80);
    expect(nums).toContain(100);
  });

  it('covers all 100 slots once streaks are expanded', () => {
    const totalSlots = qs.reduce((sum, q) => {
      if (q.streakRange) return sum + (q.streakRange.end - q.streakRange.start + 1);
      return sum + 1;
    }, 0);
    expect(totalSlots).toBe(100);
  });

  it('jackpot Q42-45 all resolve to Rumpelstiltskin', () => {
    for (const n of [42, 43, 44, 45]) {
      expect(qs.find(q => q.num === n).answer).toBe('Rumpelstiltskin');
    }
  });

  it('first streak prompt covers slots 10-13', () => {
    const s = qs.find(q => q.num === 10);
    expect(s.streakRange).toEqual({ start: 10, end: 13 });
    expect(s.category).toBe('Streak');
  });

  it('splits sub-categories are labeled Splits 1 / Splits 2', () => {
    expect(qs.find(q => q.num === 26).category).toBe('Splits 1: Star Wars Lightsabers');
    expect(qs.find(q => q.num === 30).category).toBe('Splits 2: Literature');
  });
});
