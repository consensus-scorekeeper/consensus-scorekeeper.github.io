// Regenerates the golden parser fixtures in tests/fixtures/golden/.
//
// The goldens pin the exact question records the PDF pipeline produces for
// two real packs, so parser refactors can prove they didn't change PDF
// parsing (tests/golden-pdf.test.js diffs against these files). Only rerun
// this when a parse-output change is *intended*, and review the JSON diff in
// the same commit as the parser change.
//
//   node scripts/generate-golden.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parsePdfFixture } from '../tests/helpers/pdf-fixture.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = [
  { pdf: 'assets/tutorial-pack.pdf', golden: 'tests/fixtures/golden/tutorial-pack.json' },
  { pdf: 'tests/fixtures/sample-pack-1.pdf', golden: 'tests/fixtures/golden/sample-pack-1.json' },
  // Sequentially-numbered gradwrite pack: streaks/pyramids under one number,
  // expanded by the core's renumbering pass (must yield exactly 100 slots).
  { pdf: 'tests/fixtures/gradwrite-spring-2024-pack-1.pdf', golden: 'tests/fixtures/golden/gradwrite-spring-2024-pack-1.json' },
];

await mkdir(path.join(root, 'tests/fixtures/golden'), { recursive: true });
for (const { pdf, golden } of FIXTURES) {
  const questions = await parsePdfFixture(path.join(root, pdf));
  await writeFile(path.join(root, golden), JSON.stringify(questions, null, 2) + '\n');
  console.log(`${golden}: ${questions.length} questions`);
}
