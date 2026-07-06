// Docx adapter: transpiles a Consensus packet's .docx paragraphs into the
// canonical numbered RichDoc lines the universal parser
// (parser/questions.js) consumes — the same encoding PDF and .txt packs
// use. Docx packets carry no question numbers, so this adapter assigns them
// sequentially and encodes each streak's slot span as a gap to the next
// number (the core derives streakRange from that gap, exactly as it does
// for PDFs).

import { extractDocxParagraphs } from './docx-text.js';
import { parseQuestions } from './questions.js';
import { makeLine } from './rich-doc.js';
import { makeIssue } from './diagnostics.js';

const QUOTE_CHARS = "‘’“”'\"";
const QUOTE_RE = new RegExp(`[${QUOTE_CHARS.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}]`, 'g');
function normalizeHeader(text) {
  return text.replace(QUOTE_RE, '').trim();
}

const QUARTER_RE = /^(FIRST|SECOND|THIRD|FOURTH)\s+QUARTER$/i;
const DJ_RE = /^DJ\s*$/i;
const SET_OF_RE = /^Set of (\d+)(?:\s*[:\-]\s*(.+))?$/i;
const LINKED_SET_RE = /^Linked Set of (\d+)(?:\s*[:\-]\s*(.+))?$/i;
const BLITZ_RE = /^(\d+)-Part Blitz$/i;
const SPLITS_RE = /^Splits?(?:\s*[:\-]\s*(.+))?$/i;
const JACKPOT_RE = /^Jackpot$/i;
const STREAK_RE = /^Streak$/i;
const JAILBREAK_RE = /^Jailbreak$/i;
const PART_RE = /^Part (One|Two|Three|Four|Five|Six)\s*:\s*/i;
const ANSWER_SPLIT_RE = /ANSWER\s*[:;]\s*/i;
const ANSWER_SPLIT_GLOBAL_RE = /ANSWER\s*[:;]\s*/gi;
const ANSWER_START_RE = /^\s*ANSWER\s*[:;]/i;
const A_PREFIX_RE = /^A\s*[:;]\s*/i;

// Streak prompts usually say "name up to all SIX" / "up to five" / "name 8"
// etc. We use that cap (not the raw answer count) to decide how many slots
// the streak occupies — writers sometimes list more accepted answers than
// the moderator is allowed to count. With each streak answer worth half
// points, slot count = ceil(cap / 2).
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const CAP_RE = /\b(?:up to(?:\s+all)?|name(?:\s+up\s+to)?|give(?:\s+up\s+to)?)\s+(?:all\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;

export function inferStreakSlotCount(prompt, answerCount) {
  let cap = answerCount;
  const m = prompt && CAP_RE.exec(prompt);
  if (m) {
    const word = m[1].toLowerCase();
    const n = NUMBER_WORDS[word] != null ? NUMBER_WORDS[word] : parseInt(word, 10);
    if (Number.isFinite(n) && n > 0) cap = n;
  }
  return Math.max(1, Math.ceil(cap / 2));
}

function runsPlain(runs) {
  let s = '';
  for (const r of runs) s += r.text;
  return s;
}

function sliceRuns(runs, dropChars) {
  const out = [];
  let cursor = 0;
  for (const r of runs) {
    const runEnd = cursor + r.text.length;
    if (runEnd <= dropChars) { cursor = runEnd; continue; }
    if (cursor < dropChars) out.push({ text: r.text.slice(dropChars - cursor), bold: r.bold });
    else out.push(r);
    cursor = runEnd;
  }
  return out;
}

function splitQuestionAnswer(runs) {
  const plain = runsPlain(runs);
  const m = ANSWER_SPLIT_RE.exec(plain);
  if (!m) return { question: plain.trim(), answerRuns: [] };
  const qText = plain.slice(0, m.index).trim();
  const answerCharStart = m.index + m[0].length;
  const answerRuns = [];
  let cursor = 0;
  for (const r of runs) {
    const runEnd = cursor + r.text.length;
    if (runEnd <= answerCharStart) { cursor = runEnd; continue; }
    if (cursor < answerCharStart) answerRuns.push({ text: r.text.slice(answerCharStart - cursor), bold: r.bold });
    else answerRuns.push(r);
    cursor = runEnd;
  }
  return { question: qText, answerRuns };
}

function stripPrefix(runs, regex) {
  const plain = runsPlain(runs);
  const m = regex.exec(plain);
  if (!m || m.index !== 0) return runs.slice();
  return sliceRuns(runs, m[0].length);
}

function classifyHeader(rawText) {
  const norm = normalizeHeader(rawText);
  const original = rawText.trim();
  if (QUARTER_RE.test(norm)) return { kind: 'quarter', name: norm.toUpperCase() };
  if (DJ_RE.test(norm)) return { kind: 'dj', name: 'Double Jump' };
  if (JACKPOT_RE.test(norm)) return { kind: 'jackpot', name: 'Jackpot' };
  if (SPLITS_RE.test(norm)) return { kind: 'splits', name: 'Splits' };
  if (STREAK_RE.test(norm)) return { kind: 'streak', name: 'Streak' };
  if (JAILBREAK_RE.test(norm)) return { kind: 'jailbreak', name: 'Jailbreak' };
  let m = BLITZ_RE.exec(norm);
  if (m) return { kind: 'blitz', name: `${m[1]}-Part Blitz` };
  if (SET_OF_RE.test(norm)) {
    const mOrig = SET_OF_RE.exec(original);
    const mNorm = SET_OF_RE.exec(norm);
    const use = mOrig || mNorm;
    const topic = (use[2] || '').trim();
    return { kind: 'set', name: `Set of ${use[1]}${topic ? `: ${topic}` : ''}` };
  }
  if (LINKED_SET_RE.test(norm)) {
    const mOrig = LINKED_SET_RE.exec(original);
    const mNorm = LINKED_SET_RE.exec(norm);
    const use = mOrig || mNorm;
    const topic = (use[2] || '').trim();
    return { kind: 'linked-set', name: `Linked Set of ${use[1]}${topic ? `: ${topic}` : ''}` };
  }
  return null;
}

// Merge adjacent non-blank paragraphs into logical units. Each docx
// paragraph is a candidate; we keep them separate except where merging
// produces a Q-with-answer (the next paragraph starts with ANSWER:, OR
// the current paragraph's answer was truncated by a stray newline).
// Structural lines (headers, "A:" streak prefixes) always stand alone.
// One peek across a blank handles the rare "Q[blank]ANSWER:" layout.
function mergeContinuations(paragraphs) {
  const items = [];
  for (const p of paragraphs) {
    if (runsPlain(p).trim()) items.push(p);
    else if (items.length && items[items.length - 1] !== null) items.push(null);
  }
  while (items.length && items[items.length - 1] === null) items.pop();

  const out = [];
  let i = 0;
  while (i < items.length) {
    if (items[i] === null) { i++; continue; }
    let cur = items[i].slice();
    i++;
    while (i < items.length) {
      const curPlain = runsPlain(cur);
      const curHasAnswer = ANSWER_SPLIT_RE.test(curPlain);
      let crossedBlank = false;
      let j = i;
      if (items[j] === null) {
        if (j + 1 < items.length && items[j + 1] !== null) {
          const probe = runsPlain(items[j + 1]).trim();
          if (ANSWER_START_RE.test(probe)
              && !curHasAnswer
              && !classifyHeader(curPlain.trim())
              && !A_PREFIX_RE.test(curPlain.trim())) {
            crossedBlank = true;
            j++;
          } else break;
        } else break;
      }
      const nextP = items[j];
      const nextPlain = runsPlain(nextP).trim();
      if (classifyHeader(nextPlain) || A_PREFIX_RE.test(nextPlain)) break;
      if (classifyHeader(curPlain.trim()) || A_PREFIX_RE.test(curPlain.trim())) break;
      const nextStartsAnswer = ANSWER_START_RE.test(nextPlain);
      let curEndsTruncated = false;
      if (curHasAnswer) {
        // Find last ANSWER: occurrence
        let last = null; let m;
        ANSWER_SPLIT_GLOBAL_RE.lastIndex = 0;
        while ((m = ANSWER_SPLIT_GLOBAL_RE.exec(curPlain)) !== null) last = m;
        const tail = curPlain.slice(last.index + last[0].length);
        if (!tail.trim()) curEndsTruncated = true;
        else if (curPlain !== curPlain.replace(/\s+$/, '')) curEndsTruncated = true;
      }
      if (nextStartsAnswer || curEndsTruncated) {
        cur = cur.concat(nextP);
        i = j + 1;
        continue;
      }
      if (crossedBlank) break;
      break;
    }
    out.push(cur);
  }
  return out;
}

// ==================== transpiler ====================

// Docx runs can contain literal \n (w:br) and \t (w:tab); RichDoc lines are
// single-line, so collapse them to spaces.
function sanitizeRuns(runs) {
  return runs
    .map(r => ({ text: r.text.replace(/[\r\n\t]+/g, ' '), bold: !!r.bold }))
    .filter(r => r.text);
}

// Strip leading/trailing whitespace across a run list so the joined runs
// equal the trimmed text.
function trimRuns(runs) {
  const out = runs.map(r => ({ ...r }));
  while (out.length) {
    out[0].text = out[0].text.replace(/^\s+/, '');
    if (out[0].text) break;
    out.shift();
  }
  while (out.length) {
    const last = out[out.length - 1];
    last.text = last.text.replace(/\s+$/, '');
    if (last.text) break;
    out.pop();
  }
  return out;
}

const clean = (text) => text.replace(/\s+/g, ' ').trim();

export function docxParagraphsToDoc(paragraphs) {
  const lines = [];
  const adapterIssues = [];
  let n = 0;                      // slot counter — becomes the question numbers
  let categoryKind = null;
  let categoryName = null;
  let inSplits = false;
  let splitsPendingSubtitle = false;
  let questionsInGroup = 0;       // since the current category / splits sub-title
  let streak = null;              // { prompt, answers: runs[] }
  let pendingStreakPrompt = null;
  let jackpot = null;             // { parts: string[], answerRuns }
  let overflowWarned = false;

  const emit = (text, opts) => lines.push(makeLine(text, opts));
  const emitCategory = (name) => {
    emit(name, { isBold: true });
    questionsInGroup = 0;
  };
  const nextNum = () => {
    n += 1;
    if (n > 100 && !overflowWarned) {
      overflowWarned = true;
      adapterIssues.push(makeIssue('docx-overflow', 'warn',
        'More than 100 question slots found — slots beyond 100 are ignored.'));
    }
    return n;
  };
  const emitAnswer = (answerRuns) => {
    const runs = trimRuns(sanitizeRuns(answerRuns));
    const plain = runs.map(r => r.text).join('');
    if (!plain) { emit('A:'); return; }
    emit(`A: ${plain}`, { segments: [{ text: 'A: ', bold: false }, ...runs] });
  };
  const emitQA = (questionText, answerRuns) => {
    emit(`${nextNum()}. ${clean(questionText)}`);
    emitAnswer(answerRuns);
    questionsInGroup += 1;
  };

  const flushStreak = () => {
    if (!streak) return;
    const { prompt, answers } = streak;
    streak = null;
    if (!answers.length) {
      adapterIssues.push(makeIssue('docx-empty-streak', 'warn',
        'A Streak had a prompt but no "A:" answer lines — it was dropped.'));
      return;
    }
    if (!CAP_RE.test(prompt || '')) {
      adapterIssues.push(makeIssue('docx-streak-cap-fallback', 'warn',
        `Streak prompt doesn't state a cap ("name up to N…") — its slot span was guessed from the ${answers.length} listed answers.`,
        { slot: n + 1 }));
    }
    const slots = inferStreakSlotCount(prompt, answers.length);
    const qNum = nextNum();
    emit(`${qNum}. ${clean(prompt || 'Streak')}`);
    for (const a of answers) emitAnswer(a);
    // Consume the rest of the streak's slots so the gap to the next number
    // encodes the span.
    n = qNum + slots - 1;
    questionsInGroup += 1;
  };

  const flushJackpot = () => {
    if (!jackpot) return;
    const { parts, answerRuns } = jackpot;
    jackpot = null;
    if (!parts.length) return;
    parts.forEach((part, i) => {
      emit(`${nextNum()}. ${clean(part)}`);
      // Only the final part carries the shared answer; the core propagates
      // it back to the earlier parts.
      if (i === parts.length - 1) emitAnswer(answerRuns || []);
    });
    questionsInGroup += parts.length;
  };

  for (const runs of mergeContinuations(paragraphs)) {
    const plain = clean(runsPlain(runs));
    if (!plain) continue;

    if (QUARTER_RE.test(normalizeHeader(plain))) {
      flushStreak();
      flushJackpot();
      continue;
    }

    const header = classifyHeader(plain);
    if (header) {
      // Consecutive DJ headers continue the same Double Jump block (docx
      // packs repeat the header for every pair).
      if (header.kind === 'dj' && categoryName === 'Double Jump') continue;
      flushStreak();
      flushJackpot();
      categoryKind = header.kind;
      categoryName = header.name;
      inSplits = header.kind === 'splits';
      splitsPendingSubtitle = inSplits;
      pendingStreakPrompt = null;
      if (header.kind === 'splits') {
        // Non-bold "Splits:" is the core's split trigger; the bold
        // sub-category titles follow.
        emit('Splits:');
        questionsInGroup = 0;
      } else {
        emitCategory(header.name);
        if (header.kind === 'jackpot') jackpot = { parts: [], answerRuns: [] };
      }
      continue;
    }

    // Inside Splits, the first paragraph after the "Splits" header (or after
    // the previous sub-category's 4th question) is the sub-category title.
    if (inSplits && splitsPendingSubtitle && !ANSWER_SPLIT_RE.test(plain)) {
      emitCategory(plain);
      splitsPendingSubtitle = false;
      continue;
    }

    if (categoryKind === 'jackpot' && jackpot) {
      if (PART_RE.test(plain)) {
        if (ANSWER_SPLIT_RE.test(plain)) {
          const { question, answerRuns } = splitQuestionAnswer(runs);
          jackpot.parts.push(question);
          jackpot.answerRuns = answerRuns;
          flushJackpot();
        } else {
          jackpot.parts.push(plain);
        }
        continue;
      }
      if (ANSWER_SPLIT_RE.test(plain)) {
        const { answerRuns } = splitQuestionAnswer(runs);
        jackpot.answerRuns = answerRuns;
        flushJackpot();
        continue;
      }
      if (!jackpot.parts.length) { emit(plain); continue; } // instructions
      adapterIssues.push(makeIssue('docx-stray-text', 'warn',
        'Unrecognized text inside a Jackpot was skipped.', { snippet: plain.slice(0, 80) }));
      continue;
    }

    if (categoryKind === 'streak') {
      if (A_PREFIX_RE.test(plain)) {
        const ansRuns = stripPrefix(runs, A_PREFIX_RE);
        if (!streak) {
          streak = { prompt: pendingStreakPrompt || '', answers: [ansRuns] };
          pendingStreakPrompt = null;
        } else {
          streak.answers.push(ansRuns);
        }
        continue;
      }
      if (!streak) {
        // The streak's prompt — held back and emitted by flushStreak so the
        // slot span can be encoded in the numbering.
        pendingStreakPrompt = plain;
        continue;
      }
    }

    if (ANSWER_SPLIT_RE.test(plain)) {
      flushStreak(); // a Q-with-ANSWER while a streak buffer is open ends the streak
      const { question, answerRuns } = splitQuestionAnswer(runs);
      emitQA(question, answerRuns);
      if (inSplits && questionsInGroup >= 4) splitsPendingSubtitle = true;
      continue;
    }

    // Plain paragraph with no ANSWER. At the top of a category it's the
    // moderator instructions (the core captures prose between a bold title
    // and the first question). Mid-category it's unclassifiable — keep it
    // out of the doc (it would bleed into the previous answer's text) but
    // don't let it vanish silently.
    if (questionsInGroup === 0) {
      emit(plain);
    } else {
      adapterIssues.push(makeIssue('docx-stray-text', 'warn',
        'Unrecognized text was skipped (not a question with an ANSWER:, a category header, or category instructions).',
        { snippet: plain.slice(0, 80) }));
    }
  }
  flushStreak();
  flushJackpot();

  return { doc: { source: 'docx', lines }, adapterIssues };
}

// Parse pre-extracted paragraphs ([{ text, bold }] runs per paragraph).
// `doc` is the transpiled RichDoc; the pack viewer renders it for docx packs.
export function parseDocxParagraphs(paragraphs) {
  const { doc, adapterIssues } = docxParagraphsToDoc(paragraphs);
  const { questions, issues } = parseQuestions(doc);
  return { questions, issues: [...adapterIssues, ...issues], doc };
}

export async function parseDocxBuffer(buffer) {
  return parseDocxParagraphs(await extractDocxParagraphs(buffer));
}
