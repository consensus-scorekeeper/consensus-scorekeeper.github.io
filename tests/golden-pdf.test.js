// @vitest-environment node
//
// PDF-parse regression tripwire. Runs two real packs through the live
// pipeline and diffs every question record against the committed goldens
// (tests/fixtures/golden/*, regenerated only intentionally via
// `node scripts/generate-golden.mjs`).
//
// Text-content fields are compared strictly — any diff there is a parse
// regression. pageNum/yPos are asserted separately so a deliberate
// position-accuracy change can regenerate goldens without hiding a text
// regression in the same diff.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parsePdfFixture } from './helpers/pdf-fixture.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT_FIELDS = [
  'num', 'question', 'answer', 'answerHtml',
  'category', 'posInCategory', 'categoryInstructions', 'categoryReveal', 'streakRange',
];

const FIXTURES = [
  { name: 'tutorial-pack', pdf: 'assets/tutorial-pack.pdf' },
  { name: 'sample-pack-1', pdf: 'tests/fixtures/sample-pack-1.pdf' },
  // Sequentially-numbered gradwrite pack (streaks/pyramids under one number,
  // expanded to 100 slots by the core's renumbering pass).
  { name: 'gradwrite-spring-2024-pack-1', pdf: 'tests/fixtures/gradwrite-spring-2024-pack-1.pdf' },
];

for (const { name, pdf } of FIXTURES) {
  describe(`golden PDF — ${name}`, () => {
    const golden = JSON.parse(
      readFileSync(path.join(root, `tests/fixtures/golden/${name}.json`), 'utf-8'));

    it('matches the golden parse output', async () => {
      const questions = await parsePdfFixture(path.join(root, pdf));

      const pick = (q, fields) =>
        Object.fromEntries(fields.map((f) => [f, q[f] === undefined ? null : q[f]]));
      expect(questions.map((q) => pick(q, TEXT_FIELDS)))
        .toEqual(golden.map((q) => pick(q, TEXT_FIELDS)));
      expect(questions.map((q) => pick(q, ['num', 'pageNum', 'yPos'])))
        .toEqual(golden.map((q) => pick(q, ['num', 'pageNum', 'yPos'])));
    }, 30000);
  });
}
