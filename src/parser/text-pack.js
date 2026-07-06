// Strict adapter for the plain-text pack format (the one authored format —
// the "Format pack" modal's LLM prompt emits it). Classifies each raw line,
// builds a RichDoc for the universal parser, and reports format problems
// with exact line numbers so authors can fix their pack instead of
// guessing why a question vanished.
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
// Splits, jackpots, and streaks reuse the same conventions as the PDF path
// (parseQuestions handles propagation + streakRange).

import { parseQuestions } from './questions.js';
import { makeLine } from './rich-doc.js';
import { makeIssue } from './diagnostics.js';

// Category names the format spec knows about — used only for the
// suspected-category diagnostic below, never for parsing decisions.
const CATEGORY_LIKE_RE = /^(Set of \d+|Streaks?\b|Jackpot\b|Jailbreak\b|Double Jump\b|\d+-Part Blitz\b)/i;

// Returns { questions, issues, doc } — adapter issues (with line numbers)
// first, then whatever the universal parser reports. `doc` is the RichDoc
// the pack parsed from; the pack viewer renders it for non-PDF packs.
export function parseTextPack(text) {
  const rawLines = text.split(/\r?\n/);
  const adapterIssues = [];

  // Classify every non-blank line as a question, answer, splits header,
  // category, or instruction; categories are tagged isBold=true so
  // parseQuestions picks them up the same way it does PDF-derived bold lines.
  const specs = []; // { text, isBold, kind, lineNo, num? }
  // 'start' before any question/answer; switches to 'answer' / 'splits' after
  // the corresponding marker. The first non-Q/A/Splits line that follows any
  // of those resets becomes a new category title.
  let state = 'start';
  let lastQuestionNum = null;
  let sawQuestionSinceCategory = false;

  rawLines.forEach((rawLine, idx) => {
    if (!rawLine.trim()) return;
    const lineNo = idx + 1;

    let line;
    const indentedAnswer = rawLine.match(/^\s+a\.\s+(.+\S)\s*$/);
    if (indentedAnswer) {
      line = 'A: ' + indentedAnswer[1];
    } else {
      line = rawLine.trim();
    }

    const qMatch = line.match(/^(\d{1,3})\.\s/);
    if (qMatch) {
      const num = parseInt(qMatch[1], 10);
      if (lastQuestionNum !== null && num <= lastQuestionNum) {
        adapterIssues.push(makeIssue('txt-number-regression', 'warn',
          `Question number ${num} follows question ${lastQuestionNum} — numbers must increase (skip numbers only to span a streak).`,
          { lineNo, slot: num }));
      }
      lastQuestionNum = num;
      sawQuestionSinceCategory = true;
      specs.push({ text: line, isBold: false, kind: 'question', lineNo, num });
      state = 'question';
      return;
    }
    if (/^A:\s?/.test(line)) {
      if (!sawQuestionSinceCategory) {
        adapterIssues.push(makeIssue('txt-orphan-answer', 'warn',
          `"A:" line appears before any numbered question — it will not attach to anything.`,
          { lineNo }));
      }
      specs.push({ text: line, isBold: false, kind: 'answer', lineNo });
      state = 'answer';
      return;
    }
    if (/^Splits?:/i.test(line)) {
      // parseQuestions detects this regardless of bold; leave non-bold.
      specs.push({ text: line, isBold: false, kind: 'splits', lineNo });
      state = 'splits';
      sawQuestionSinceCategory = false;
      return;
    }

    const isCategory = state === 'start' || state === 'answer' || state === 'splits';
    if (!isCategory && state === 'question' && CATEGORY_LIKE_RE.test(line)) {
      // A new category can only start after an answer. A category-looking
      // line right after a question means that question has no "A:" — the
      // parser will treat this line as question text and quietly attach the
      // NEXT question's answer, so call it out.
      adapterIssues.push(makeIssue('txt-suspected-category', 'warn',
        `This line looks like a category header, but the question before it has no "A:" answer — it was treated as part of the question.`,
        { lineNo, snippet: line }));
    }
    specs.push({ text: line, isBold: isCategory, kind: isCategory ? 'category' : 'instruction', lineNo });
    if (isCategory) sawQuestionSinceCategory = false;
    state = isCategory ? 'category' : 'instruction';
  });

  // A question must eventually reach an "A:" line. Follow-on question lines
  // are fine (that's how jackpot clue chains are written — the shared answer
  // follows the last clue) as long as the chain terminates in an answer;
  // instruction lines are wrapped question text. Hitting a category/splits
  // header or the end of the file first means the question has no answer.
  for (let i = 0; i < specs.length; i++) {
    if (specs[i].kind !== 'question') continue;
    let verdict = 'missing';
    for (let j = i + 1; j < specs.length; j++) {
      const kind = specs[j].kind;
      if (kind === 'instruction' || kind === 'question') continue;
      if (kind === 'answer') verdict = 'ok';
      break;
    }
    if (verdict === 'missing') {
      adapterIssues.push(makeIssue('txt-question-without-answer', 'warn',
        `Question ${specs[i].num} has no "A:" answer line before the next category.`,
        { lineNo: specs[i].lineNo, slot: specs[i].num }));
    }
  }

  const doc = {
    source: 'txt',
    lines: specs.map(s => makeLine(s.text, { isBold: s.isBold, lineNo: s.lineNo })),
  };
  const { questions, issues: coreIssues } = parseQuestions(doc);
  return { questions, issues: [...adapterIssues, ...coreIssues], doc };
}
