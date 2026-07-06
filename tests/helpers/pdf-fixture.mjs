// Parses a PDF file through the live production pipeline (pdf text
// extraction + parseQuestions) under Node, using the same pdfjs-dist version
// index.html pins on the CDN. Shared by scripts/generate-golden.mjs and
// tests/golden-pdf.test.js so the golden generator and the golden test can
// never drift apart.

import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractRichDocFromPdf } from '../../src/parser/pdf-text.js';
import { parseQuestions } from '../../src/parser/questions.js';

export async function parsePdfFixture(filePath) {
  const buf = await readFile(filePath);
  const pdf = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true, verbosity: 0 }).promise;
  try {
    const { doc } = await extractRichDocFromPdf(pdf);
    return parseQuestions(doc).questions;
  } finally {
    await pdf.destroy();
  }
}
