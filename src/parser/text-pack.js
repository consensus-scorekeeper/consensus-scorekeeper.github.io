// Parses a plain-text quiz pack into the same shape parseQuestions consumes.
// Lets users feed the scorekeeper a .txt file instead of a PDF.
//
// Text format:
//   Category Name             <- short line; first non-Q/A line after an answer
//   Optional instructions.    <- subsequent non-Q/A line(s)
//   1. Question text          <- numbered question
//   A: answer                 <- "A: " marker; multiple lines allowed for streaks
//   2. Another question
//   A: answer
//
//   Indented "    a. answer" is also accepted as an answer marker (matches the
//   informal convention many packs use); it's normalized to "A: ".
//
// Splits, jackpots, and streaks reuse the same conventions as the PDF parser
// (parseQuestions handles propagation + streakRange).

import { parseQuestions } from './questions.js';

export function parseTextPack(text) {
  const rawLines = text.split(/\r?\n/);

  // Normalize each input line to either a question, answer, splits header,
  // category, or instruction; tag categories with isBold=true so parseQuestions
  // picks them up the same way it does PDF-derived bold lines.
  const specs = [];
  // 'start' before any question/answer; switches to 'answer' / 'splits' after
  // the corresponding marker. The first non-Q/A/Splits line that follows any
  // of those resets becomes a new category title.
  let state = 'start';

  for (const rawLine of rawLines) {
    if (!rawLine.trim()) continue;

    let line;
    const indentedAnswer = rawLine.match(/^\s+a\.\s+(.+\S)\s*$/);
    if (indentedAnswer) {
      line = 'A: ' + indentedAnswer[1];
    } else {
      line = rawLine.trim();
    }

    if (/^\d{1,3}\.\s/.test(line)) {
      specs.push({ text: line, isBold: false });
      state = 'question';
      continue;
    }
    if (/^A:\s/.test(line)) {
      specs.push({ text: line, isBold: false });
      state = 'answer';
      continue;
    }
    if (/^Splits?:/i.test(line)) {
      // parseQuestions detects this regardless of bold; leave non-bold.
      specs.push({ text: line, isBold: false });
      state = 'splits';
      continue;
    }

    const isCategory = state === 'start' || state === 'answer' || state === 'splits';
    specs.push({ text: line, isBold: isCategory });
    state = isCategory ? 'category' : 'instruction';
  }

  // Build the rich-segment structure parseQuestions expects. Mirrors the
  // buildInputs helper used in tests/parse-questions.test.js.
  const lines = specs.map(s => ({ text: s.text, isBold: s.isBold }));
  const richSegments = [];
  const lineStartPositions = [0];
  let combined = '';

  specs.forEach((s, i) => {
    richSegments.push({ str: s.text, bold: s.isBold, page: 1, y: 700 - i * 10 });
    combined += s.text;
    if (i < specs.length - 1) {
      richSegments.push({ str: ' ', bold: false, page: 1, y: 700 - i * 10 });
      combined += ' ';
      lineStartPositions.push(combined.length);
    }
  });

  const posMap = [];
  for (let si = 0; si < richSegments.length; si++) {
    const seg = richSegments[si];
    for (let ci = 0; ci < seg.str.length; ci++) {
      posMap.push({ segIdx: si, charIdx: ci });
    }
  }

  return parseQuestions(lines, combined, richSegments, posMap, lineStartPositions);
}
