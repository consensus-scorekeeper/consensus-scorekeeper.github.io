// Pure question-text parser — the single parsing core every packet format
// funnels through. Given a RichDoc (see parser/rich-doc.js; built by the
// pdf/docx/txt adapters), this extracts the question + answer for each
// numbered "N." in the text, attaches category metadata, and returns the
// questions sorted by number.

import { escapeHtml } from '../util/escape.js';
import { flattenDoc } from './rich-doc.js';

export const SECTION_WORDS = [
  'END OF FIRST QUARTER', 'END OF FIRST HALF', 'END OF THIRD QUARTER', 'END OF GAME',
  'END OF SECOND QUARTER', 'END OF FOURTH QUARTER', 'END OF SECOND HALF',
  'FIRST QUARTER', 'SECOND QUARTER', 'THIRD QUARTER', 'FOURTH QUARTER',
  'FIRST HALF', 'SECOND HALF',
  'Double Jump', 'Jackpot', '5-Part Blitz', '12-Part Blitz', 'Streak',
  'Jailbreak',
];

// Writer-attribution tag some packs (e.g. RenWrite) append to category
// titles and answer lines: "<JC>", "<IR>", or a collab like "<JC/EM>".
// Some lines carry a stray quote right after the tag (`<IR>"`) — an
// artifact of the pack's authoring — so an abutting quote is absorbed too.
const TRAILING_WRITER_TAG_RE = /\s*<[A-Za-z]{1,4}(?:\/[A-Za-z]{1,4})*>["”']?\s*$/;

export function cleanTrailing(text) {
  // Match SECTION_WORDS case-sensitively only. Page headers ("SECOND HALF",
  // "FIRST QUARTER", etc.) are always uppercase in actual PDFs, so a
  // case-sensitive match catches them. A case-insensitive match would
  // otherwise truncate question text on the lowercase phrase "second half"
  // (e.g., "blew a 12-point second half lead").
  for (const sw of SECTION_WORDS) {
    const idx = text.indexOf(sw);
    if (idx !== -1) text = text.substring(0, idx);
  }
  text = text.replace(/\s+(?:Set of \d+.*|Splits?:.*|PACK \d+.*|\d+-Part Blitz.*|Streaks?.*|Streak)$/i, '');
  text = text.replace(TRAILING_WRITER_TAG_RE, '');
  return text.trim();
}

// A streak's cap is how many answers the moderator may count. Prompts that
// state a numeric cap ("name up to all SIX" / "up to five" / "name 8") win
// over the raw answer count — writers sometimes list more accepted answers
// than count ("up to six of the ten largest…"). Prompts with no numeric cap
// ("name up to every…") are equally standard; there the listed answers ARE
// the cap. Each streak answer is worth half a point, so a pack's streaks
// jointly occupy cap-total / 2 slots, with odd caps sharing a slot across
// streaks (see the docx adapter's flushStreak and the sequential-numbering
// expansion pass below for the two allocation sites).
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const CAP_RE = /\b(?:up to(?:\s+all)?|name(?:\s+up\s+to)?|give(?:\s+up\s+to)?)\s+(?:all\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;

export function inferStreakCap(prompt, answerCount) {
  const m = prompt && CAP_RE.exec(prompt);
  if (m) {
    const word = m[1].toLowerCase();
    const n = NUMBER_WORDS[word] != null ? NUMBER_WORDS[word] : parseInt(word, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return answerCount;
}

// Lines that are certainly structural or a known category header — used to
// end streak answer capture. Some packs set a streak's listed answers in
// bold, so "bold" alone can't separate an answer line from the next
// category's title; these are the titles that actually follow streaks.
const KNOWN_HEADER_RE = /^(?:\d+-Part\b|(?:Linked\s+)?Set of \d+|Splits?\s*:|Pyramid\b|Jackpot\b|Streaks?\b|Jailbreak\b|Double Jump\b|Mystery\b)/i;
function isKnownHeaderText(text) {
  if (STRUCTURAL_RE.test(text)) return true;
  for (const sw of SECTION_WORDS) if (text.startsWith(sw)) return true;
  return KNOWN_HEADER_RE.test(text);
}

// Split a multi-part question ("Part 1: … Part 2: …" or a Gradwrite
// Pyramid's "Clue A: … Clue B: …") into its part chunks. A duplicated
// marker with no content between ("Part 4: Part 4: …" — a real pack typo)
// contributes no chunk.
const PART_MARKER_SPLIT_RE = /\s(?=(?:Part \d+|Clue [A-Z])\s*:)/;
const PART_MARKER_RE = /^(?:Part \d+|Clue [A-Z])\s*:\s*/;
function splitPartChunks(text) {
  return text.split(PART_MARKER_SPLIT_RE)
    .filter(p => p.replace(PART_MARKER_RE, '').trim() !== '');
}

// True when the "A:" at `pos` in `text` is an answer marker rather than a
// Pyramid clue label ("… Clue A: I am …" is clue text, not an answer).
function isAnswerMarker(text, pos) {
  return !/\bClue\s*$/i.test(text.slice(Math.max(0, pos - 6), pos));
}

// Returns the category title a line carries, or null if the line isn't a
// bold title. Normally that's just `line.isBold`, but a trailing writer tag
// is set in the body font ("Double Jump <JC>"), so a title line may be
// all-bold *except* the tag — accept that too, and strip the tag from the
// title either way.
function boldTitleOf(line) {
  const m = line.text.match(TRAILING_WRITER_TAG_RE);
  const title = m ? line.text.slice(0, m.index).trim() : line.text;
  if (line.isBold) return title || line.text;
  if (!m || !title) return null;
  // Every non-whitespace char before the tag must come from a bold segment.
  let pos = 0;
  for (const seg of line.segments || []) {
    const end = pos + seg.text.length;
    if (!seg.bold && pos < m.index) {
      if (seg.text.slice(0, Math.min(end, m.index) - pos).trim()) return null;
    }
    pos = end;
  }
  return title;
}

// Known structural lines that aren't categories. Case-sensitive on purpose:
// page headers ("PACK 1", "END OF FIRST QUARTER", "FIRST HALF", ...) are
// always uppercase in real PDFs, so case-sensitive matching catches them
// without risking a false-positive on an instruction line that happens to
// start with the lowercase word "first" or "second".
export const STRUCTURAL_RE = /^(PACK \d+|END OF|FIRST|SECOND|THIRD|FOURTH|_{3,}|20\d\d-\d\d|Post-Secondary|Head|Editor|Writers)/;

// Extract rich text (with bold flags) for a range of the combined string
export function extractRichRange(start, end, richSegments, posMap) {
  if (start >= end || start >= posMap.length) return [];
  const result = [];
  let curBold = null;
  let curStr = '';
  for (let i = start; i < end && i < posMap.length; i++) {
    const { segIdx } = posMap[i];
    const bold = richSegments[segIdx].bold;
    if (bold !== curBold && curStr) {
      result.push({ str: curStr, bold: curBold });
      curStr = '';
    }
    curBold = bold;
    curStr += richSegments[segIdx].str[posMap[i].charIdx];
  }
  if (curStr) result.push({ str: curStr, bold: curBold });
  return result;
}

// Trim rich segments to a cleaned plain text's length (cleaning only ever
// removes from the end, so a prefix of the runs covers the cleaned text).
function trimRichTo(rich, cleanLen) {
  let tLen = 0;
  const trimmed = [];
  for (const seg of rich) {
    if (tLen >= cleanLen) break;
    const rem = cleanLen - tLen;
    if (seg.str.length <= rem) { trimmed.push(seg); tLen += seg.str.length; }
    else { trimmed.push({ str: seg.str.substring(0, rem), bold: seg.bold }); tLen += rem; }
  }
  return trimmed;
}

// Convert rich segments to HTML
export function richToHtml(segments) {
  return segments.map(s => {
    const text = escapeHtml(s.str);
    return s.bold ? `<b><u>${text}</u></b>` : text;
  }).join('');
}

// Total question slots a parsed list covers (streaks span multiple slots).
export function computeTotalSlots(questions) {
  return questions.reduce((sum, q) => {
    if (q.streakRange) return sum + (q.streakRange.end - q.streakRange.start + 1);
    return sum + 1;
  }, 0);
}

// Returns { questions, issues }. Issues follow the shape documented in
// parser/diagnostics.js (constructed inline here to avoid an import cycle —
// diagnostics.js imports computeTotalSlots from this module).
export function parseQuestions(doc) {
  const lines = doc.lines;
  const { combined, segments: richSegments, posMap, lineStartPositions } = flattenDoc(doc);
  const issues = [];
  // Step 1: Build category map using bold detection from PDF fonts
  // A bold line that isn't a question, structural marker, answer/prompt line,
  // or bare number is a category title.
  const categoryMap = {};
  const revealByNum = {};         // question num → parenthesized note following its answer
  const streakAnswerLines = {};   // streak question num → its captured answer lines
  let capturingStreakNum = null;  // streak num whose answer list is being collected
  let currentCategory = null;
  let currentInstructions = '';   // accumulated prose between a category title and its first question
  let captureInstructions = false; // toggled true after a bold category title; false on first qMatch
  let categoryQuestionCount = 0;
  let inSplit = false;
  let splitCount = 0;
  let lastQNum = null;            // most recent question number seen
  let afterAnswer = false;        // an answer line has appeared since that question

  for (const line of lines) {
    const text = line.text;
    // Question line (starts with "N."). A bare "N." on its own line counts
    // too — Gradwrite-style Pyramids put the number alone above unnumbered
    // "Part N:" lines.
    const qMatch = text.match(/^(\d{1,3})\.(?:\s|$)/);
    if (qMatch) {
      capturingStreakNum = null;
      const num = parseInt(qMatch[1]);
      if (num >= 1 && num <= 100) {
        lastQNum = num;
        afterAnswer = false;
        if (currentCategory) {
          categoryQuestionCount++;
          categoryMap[num] = {
            category: currentCategory,
            posInCategory: categoryQuestionCount,
            categoryInstructions: currentInstructions || null,
          };
        }
      }
      captureInstructions = false;
      continue;
    }
    // Skip structural markers (END OF, QUARTER labels, etc.)
    if (STRUCTURAL_RE.test(text) || text.length < 2) { capturingStreakNum = null; continue; }
    // Skip answer/accept/prompt/reject lines. A streak's "A:" line starts
    // its answer capture (used to size and split sequential-numbered
    // streaks below); later "A:" lines append.
    if (/^(A:\s|\(accept|\(prompt|\(reject)/i.test(text)) {
      afterAnswer = true;
      if (/^A:\s/i.test(text) && lastQNum !== null
          && categoryMap[lastQNum] && /streak/i.test(categoryMap[lastQNum].category || '')) {
        (streakAnswerLines[lastQNum] = streakAnswerLines[lastQNum] || []).push({ lines: [line], isA: true });
        capturingStreakNum = lastQNum;
      }
      continue;
    }
    // Skip quarter/half markers (page headers — always uppercase in real PDFs).
    if (/^(QUARTER|HALF)/.test(text)) { capturingStreakNum = null; continue; }
    // Skip bare numbers
    if (/^\d+$/.test(text.trim())) continue;

    // Detect "Splits:" header — next bold lines are numbered sub-categories
    if (/^Splits?:/i.test(text)) {
      capturingStreakNum = null;
      inSplit = true;
      splitCount = 0;
      captureInstructions = false;
      currentInstructions = '';
      continue;
    }

    // Streak answers frequently continue on lines without their own "A:" —
    // one answer per line, sometimes even set in bold (which would otherwise
    // read as a category title). Capture them until a known header or a
    // reveal note (a fully-parenthesized line, handled below) ends the
    // block; an unrecognized line here is an answer, never a title.
    if (capturingStreakNum !== null) {
      if (isKnownHeaderText(text) || /^\(.+\)$/.test(text.trim())) {
        capturingStreakNum = null;
      } else {
        // A line completing an unclosed parenthesis is the previous
        // answer's wrap ("… (do not accept or prompt on only" / "Rimsky or
        // Korsakov )"), not a new answer.
        const entries = streakAnswerLines[capturingStreakNum];
        const last = entries[entries.length - 1];
        const lastText = last.lines.map(l => l.text).join(' ');
        const unclosed = (lastText.match(/\(/g) || []).length > (lastText.match(/\)/g) || []).length;
        if (unclosed) last.lines.push(line);
        else entries.push({ lines: [line], isA: false });
        continue;
      }
    }

    // A bold line after an answer = category title
    const boldTitle = boldTitleOf(line);
    if (boldTitle) {
      if (inSplit) {
        // Sub-category within a split
        splitCount++;
        currentCategory = `Splits ${splitCount}: ${boldTitle}`;
      } else {
        currentCategory = boldTitle;
      }
      categoryQuestionCount = 0;
      currentInstructions = '';
      captureInstructions = true;
      // A non-split bold category ends split mode after 2 sub-categories.
      if (inSplit && splitCount >= 2) inSplit = false;
      continue;
    }

    // Non-bold prose line that survived all skips. If we just saw a category
    // title and haven't hit the first question yet, treat it as category
    // instructions for the moderator (e.g., "Set of 3: Before and After"
    // explains the answer format before Q63). A fully-parenthesized line
    // after a question's answer is a reveal note — e.g. a Mystery category's
    // "(The theme was Alfred Hitchcock films.)" — kept for display with that
    // question. Anything else is ignored.
    if (captureInstructions) {
      currentInstructions = (currentInstructions ? currentInstructions + ' ' : '') + text;
    } else if (afterAnswer && lastQNum !== null && /^\(.+\)$/.test(text.trim())) {
      const note = text.trim().replace(/\s+/g, ' ');
      revealByNum[lastQNum] = revealByNum[lastQNum] ? `${revealByNum[lastQNum]} ${note}` : note;
    }
  }

  // Step 2: Find question positions in combined text.
  // Mid-sentence numbers like the "3." in "secant of 5 pi over 3." (inside Q16
  // of jackpot_bug.pdf) would otherwise be matched as Q3 and would corrupt the
  // segment boundaries for surrounding real questions. We reject any match that
  // isn't at the start of a logical PDF line.
  //
  // Two parts:
  //  - Switch from `(?:^|\s)` to `\b` so the regex doesn't consume the leading
  //    space. Old form: a bogus mid-sentence match swallowed the space the next
  //    real question depended on, dropping it entirely from questionStarts.
  //  - `isLineStart(p)` — accepts p when the latest preceding `lineStarts`
  //    position is reachable through only whitespace. This permits leading
  //    whitespace inside the first text item of a line (some PDFs emit it).
  const lineStarts = lineStartPositions ? new Set(lineStartPositions) : null;
  function isLineStart(p) {
    if (!lineStarts) return true;
    if (lineStarts.has(p)) return true;
    for (let i = p - 1; i >= 0; i--) {
      if (combined[i] !== ' ' && combined[i] !== '\t') return false;
      if (lineStarts.has(i)) return true;
    }
    return false;
  }
  const questionStarts = [];
  const numRegex = /\b(\d{1,3})\.\s/g;
  let m;
  while ((m = numRegex.exec(combined)) !== null) {
    const num = parseInt(m[1]);
    const numStartPos = m.index;
    if (num >= 1 && num <= 100 && isLineStart(numStartPos)) {
      // Question numbers only ever count up. A line-start number that
      // regresses is prose that happens to end a line on "N." (e.g. a
      // Pyramid clue's "…beginning 1, 1, 2, 3, 5." wrapping before
      // "5. What am I?") — accepting it would truncate the real question
      // it sits inside.
      const prevNum = questionStarts.length ? questionStarts[questionStarts.length - 1].num : 0;
      if (num < prevNum) {
        issues.push({
          code: 'out-of-sequence-number', severity: 'warn',
          message: `Found "${num}." at a line start after question ${prevNum} — treated as question text, not a question number.`,
        });
        continue;
      }
      questionStarts.push({ num, pos: numStartPos });
    } else if (num > 100 && isLineStart(numStartPos)) {
      issues.push({
        code: 'out-of-range-number', severity: 'warn',
        message: `Found "${num}." at a line start — question numbers above 100 are ignored.`,
      });
    }
  }

  // Returns the bare title of the next question's category if it differs from the current one.
  // Used to strip a trailing category title that bleeds into the prior answer's text — happens
  // between split sub-categories, where (unlike normal categories) there is no "Set of N" marker
  // between groups for cleanTrailing's greedy regex to absorb.
  function nextCategoryTitle(curIdx, curCat) {
    if (curIdx + 1 >= questionStarts.length) return null;
    const nextCat = categoryMap[questionStarts[curIdx + 1].num];
    if (!nextCat || !nextCat.category) return null;
    if (curCat && nextCat.category === curCat.category) return null;
    return nextCat.category.replace(/^Splits \d+:\s*/, '').trim() || null;
  }
  function stripTrailingTitle(text, title) {
    if (!title) return text;
    const t = text.replace(/\s+$/, '');
    if (t.endsWith(title)) return t.substring(0, t.length - title.length).replace(/\s+$/, '');
    return text;
  }
  // Remove trailing bleed (section words, the next category's title, a
  // reveal note, writer tags) from an answer's text. A reveal note came
  // after the answer's last line, so everything from it onward — the note
  // itself plus whatever headers follow it — is bleed; truncate there first.
  // The title must be tried on the *uncleaned* text: cleanTrailing can eat
  // part of a title it has a pattern for ("Linked Set of 5" loses
  // " Set of 5"), leaving a fragment endsWith() can no longer see.
  function cleanAnswerText(text, title, reveal = null) {
    if (reveal) {
      const idx = text.indexOf(reveal);
      if (idx !== -1) text = text.substring(0, idx);
    }
    const untagged = text.replace(TRAILING_WRITER_TAG_RE, '');
    const stripped = stripTrailingTitle(untagged, title);
    if (stripped !== untagged) return cleanTrailing(stripped);
    return stripTrailingTitle(cleanTrailing(text), title);
  }

  const questions = [];
  const answerCountByRecord = new Map(); // record → accepted-answer count (streak sizing)
  for (let i = 0; i < questionStarts.length; i++) {
    const start = questionStarts[i];
    const endPos = i + 1 < questionStarts.length ? questionStarts[i + 1].pos : combined.length;
    const segment = combined.substring(start.pos, endPos);
    const catInfo = categoryMap[start.num] || null;
    const isStreakQ = !!(catInfo && catInfo.category && /streak/i.test(catInfo.category));
    const nextTitle = nextCategoryTitle(i, catInfo);
    const reveal = revealByNum[start.num] || null;
    // Look up source page + Y position from the rich segment that contains this
    // question's "N. " marker. Used to scroll the inline PDF to the question.
    let qPageNum = null, qYPos = null;
    if (posMap[start.pos]) {
      const seg = richSegments[posMap[start.pos].segIdx];
      if (seg) { qPageNum = seg.page || null; qYPos = (typeof seg.y === 'number') ? seg.y : null; }
    }

    // First "A:" answer marker with a word boundary — skipping a Pyramid
    // clue label's "A:" ("… Clue A: I am …" is clue text, not an answer).
    let aMatchIdx = -1;
    const boundaryARe = /\bA:/g;
    let am;
    while ((am = boundaryARe.exec(segment)) !== null) {
      if (isAnswerMarker(segment, am.index)) { aMatchIdx = am.index; break; }
    }
    if (aMatchIdx !== -1) {
      const qPrefix = segment.match(/^\d{1,3}\.\s+/);
      if (qPrefix) {
        const questionText = segment.slice(qPrefix[0].length, aMatchIdx).trim().replace(/\s+/g, ' ');

        // Find where "A:" starts in the combined string for this question
        let aIdx = segment.indexOf('A:');
        while (aIdx !== -1 && !isAnswerMarker(segment, aIdx)) aIdx = segment.indexOf('A:', aIdx + 2);
        const answerStartInCombined = start.pos + aIdx + 2; // skip "A:"
        // Skip whitespace after "A:"
        let ansStart = answerStartInCombined;
        while (ansStart < endPos && combined[ansStart] === ' ') ansStart++;

        // Get rich answer segments
        let answerRich = extractRichRange(ansStart, endPos, richSegments, posMap);

        // Also get plain answer for cleaning
        let answerPlain = combined.substring(ansStart, endPos).trim().replace(/\s+/g, ' ');
        answerPlain = cleanAnswerText(answerPlain, nextTitle, reveal);

        // Check for multiple A: answers (common in streaks)
        const aMatches = [];
        let aSearchFrom = 0;
        while (true) {
          const aPos = segment.indexOf('A:', aSearchFrom);
          if (aPos === -1) break;
          if (isAnswerMarker(segment, aPos)) aMatches.push(aPos);
          aSearchFrom = aPos + 2;
        }
        // A streak whose answers were listed one per line under a single
        // "A:" (captured in the category walk above) — split per line so
        // the record matches the multi-"A:" shape.
        const streakLines = isStreakQ ? (streakAnswerLines[start.num] || []) : [];
        const splitStreakLines = aMatches.length <= 1 && streakLines.length > 1;
        let answerCount = aMatches.length > 1 ? aMatches.length
          : splitStreakLines ? streakLines.length
          : aMatches.length;
        let answerHtml;
        if (aMatches.length > 1) {
          // Multiple answers — build rich HTML for each, separated by newlines
          const plainParts = [];
          const htmlParts = [];
          for (let ai = 0; ai < aMatches.length; ai++) {
            const aPos = aMatches[ai];
            const aContentStart = start.pos + aPos + 2;
            let as2 = aContentStart;
            while (as2 < endPos && combined[as2] === ' ') as2++;
            const aEnd = ai + 1 < aMatches.length ? start.pos + aMatches[ai + 1] : endPos;
            const rich = extractRichRange(as2, aEnd, richSegments, posMap);
            const rawText = combined.substring(as2, aEnd).trim().replace(/\s+/g, ' ');
            const plainText = ai === aMatches.length - 1
              ? cleanAnswerText(rawText, nextTitle, reveal)
              : cleanTrailing(rawText);
            htmlParts.push(richToHtml(trimRichTo(rich, plainText.length)));
            plainParts.push(plainText);
          }
          answerHtml = htmlParts.map(h => `<div>Answer: ${h}</div>`).join('');
          answerPlain = plainParts.join(' | ');
        } else if (splitStreakLines) {
          const plainParts = [];
          const htmlParts = [];
          for (const entry of streakLines) {
            let runs = [];
            entry.lines.forEach((ln, li) => {
              if (li > 0) runs.push({ str: ' ', bold: false });
              for (const s of ln.segments || []) runs.push({ str: s.text, bold: !!s.bold });
            });
            let plainText = entry.lines.map(l => l.text).join(' ');
            if (entry.isA) {
              // Strip the "A:" prefix (and following spaces) from text + runs.
              let drop = plainText.match(/^A:\s*/i)[0].length;
              plainText = plainText.slice(drop);
              const kept = [];
              for (const r of runs) {
                if (drop >= r.str.length) { drop -= r.str.length; continue; }
                kept.push(drop > 0 ? { str: r.str.slice(drop), bold: r.bold } : r);
                drop = 0;
              }
              runs = kept;
            }
            plainText = cleanTrailing(plainText.trim().replace(/\s+/g, ' '));
            if (!plainText) continue;
            htmlParts.push(richToHtml(trimRichTo(runs, plainText.length)));
            plainParts.push(plainText);
          }
          answerHtml = htmlParts.map(h => `<div>Answer: ${h}</div>`).join('');
          answerPlain = plainParts.join(' | ');
          answerCount = plainParts.length;
        } else {
          // Trim the rich segments to match cleaned plain text length
          // (removes trailing section headers from the rich segments too).
          answerHtml = richToHtml(trimRichTo(answerRich, answerPlain.length));
        }

        if (questionText.length > 1) {
          if (!answerPlain) {
            answerPlain = '(answer not parsed)';
            answerHtml = '<i>(answer not parsed)</i>';
            issues.push({
              code: 'unparsed-answer', severity: 'warn', slot: start.num,
              message: `Question ${start.num} has an "A:" marker but its answer text could not be extracted.`,
            });
          }
          // For streaks, calculate the range of question numbers this streak covers
          // (from this Q's number to next Q's number - 1)
          let streakEnd = null;
          if (isStreakQ && i + 1 < questionStarts.length) {
            streakEnd = questionStarts[i + 1].num - 1;
          } else if (isStreakQ) {
            streakEnd = 100; // last question
          }
          const record = {
            num: start.num,
            question: cleanTrailing(questionText),
            answer: answerPlain,
            answerHtml,
            category: catInfo ? catInfo.category : null,
            posInCategory: catInfo ? catInfo.posInCategory : null,
            categoryInstructions: catInfo ? (catInfo.categoryInstructions || null) : null,
            categoryReveal: reveal,
            streakRange: isStreakQ ? { start: start.num, end: streakEnd } : null,
            pageNum: qPageNum,
            yPos: qYPos,
          };
          questions.push(record);
          answerCountByRecord.set(record, answerCount);
        } else {
          issues.push({
            code: 'empty-question', severity: 'warn', slot: start.num,
            message: `Question ${start.num} was found but its text is empty — it was dropped.`,
          });
        }
      }
    } else {
      const qMatch = segment.match(/^\d{1,3}\.\s+(.*)/);
      if (qMatch && cleanTrailing(qMatch[1].trim().replace(/\s+/g, ' ')).length > 1) {
        const questionText = cleanTrailing(qMatch[1].trim().replace(/\s+/g, ' '));
        questions.push({
          num: start.num,
          question: questionText,
          answer: '(see final part for answer)',
          answerHtml: '<i>(see final part for answer)</i>',
          category: catInfo ? catInfo.category : null,
          posInCategory: catInfo ? catInfo.posInCategory : null,
          categoryInstructions: catInfo ? (catInfo.categoryInstructions || null) : null,
          categoryReveal: reveal,
          pageNum: qPageNum,
          yPos: qYPos,
        });
      } else {
        issues.push({
          code: 'empty-question', severity: 'warn', slot: start.num,
          message: `Question ${start.num} was found but its text is empty — it was dropped.`,
        });
      }
    }
  }
  const seen = new Set();
  const unique = [];
  for (const q of questions) {
    if (!seen.has(q.num)) {
      seen.add(q.num);
      unique.push(q);
    } else if (q.num < 100 && !seen.has(q.num + 1) && !questions.some(o => o.num === q.num + 1)) {
      // An otherwise-sequential pack that numbers two questions "20." has
      // almost certainly mistyped the second one's "21" — slide it into the
      // free number rather than dropping a real question.
      issues.push({
        code: 'duplicate-number', severity: 'warn', slot: q.num,
        snippet: q.question.slice(0, 80),
        message: `Question ${q.num} appears more than once — the second occurrence was renumbered to ${q.num + 1}.`,
      });
      q.num += 1;
      if (q.streakRange) q.streakRange = { start: q.num, end: Math.max(q.streakRange.end, q.num) };
      seen.add(q.num);
      unique.push(q);
    } else {
      issues.push({
        code: 'duplicate-number', severity: 'warn', slot: q.num,
        snippet: q.question.slice(0, 80),
        message: `Question ${q.num} appears more than once — the duplicate was dropped.`,
      });
    }
  }
  unique.sort((a, b) => a.num - b.num);

  // Post-process: open up slots inside sequentially-numbered packs.
  // Consensus packs give a multi-slot question (streak, Jackpot, Pyramid)
  // several numbers, so its span arrives encoded as a numbering gap — but
  // Gradwrite's 2024 packs number every question sequentially, leaving such
  // questions ONE number even though they occupy several slots (their
  // quarters only sum to the standard 25 slots when a Jackpot takes one
  // slot per part, a Pyramid takes parts − 1, and streaks take their
  // cumulative half-point allocation). Where a multi-slot question's own
  // numbering leaves it no room (the next question is number + 1), open
  // the gap by shifting every later question — the same renumbering the
  // docx adapter applies to unnumbered packets. Packs whose numbering
  // already leaves gaps are never touched.
  let shift = 0;
  let streakCapHalves = 0; // cumulative caps across the pack's expanded streaks
  for (let i = 0; i < unique.length; i++) {
    const q = unique[i];
    const gapToNext = i + 1 < unique.length ? unique[i + 1].num - q.num : null;
    q.num += shift;
    if (q.streakRange) {
      q.streakRange.start += shift;
      q.streakRange.end += shift;
    }
    if (gapToNext !== 1) continue;
    let span = 1;
    if (q.streakRange) {
      // Slots are allocated from the cumulative cap total, not per streak:
      // streak answers are worth half a point, so two odd-capped streaks
      // (5 + 5) fill 5 slots, not ceil-each's 6.
      const cap = inferStreakCap(q.question, answerCountByRecord.get(q) || 1);
      const allocated = Math.ceil(streakCapHalves / 2);
      streakCapHalves += cap;
      span = Math.ceil(streakCapHalves / 2) - allocated;
      if (span < 1) {
        span = 1;
        streakCapHalves = (allocated + 1) * 2;
      }
      q.streakRange.end = q.num + span - 1;
    } else if (q.category && /pyramid|jackpot/i.test(q.category)) {
      const parts = splitPartChunks(q.question).length;
      if (parts >= 2) span = /jackpot/i.test(q.category) ? parts : parts - 1;
    }
    if (span > 1) shift += span - 1;
  }

  // Post-process: propagate Jackpot/multi-part answers to preceding parts
  for (let i = unique.length - 1; i >= 0; i--) {
    if (unique[i].answer !== '(see final part for answer)') continue;
    // Find the next question with a real answer (the final part of this group)
    for (let j = i + 1; j < unique.length; j++) {
      if (unique[j].answer !== '(see final part for answer)') {
        unique[i].answer = unique[j].answer;
        unique[i].answerHtml = unique[j].answerHtml;
        break;
      }
    }
    if (unique[i].answer === '(see final part for answer)') {
      issues.push({
        code: 'jackpot-unresolved', severity: 'error', slot: unique[i].num,
        message: `Question ${unique[i].num} is a multi-part clue whose final answer was never found — it has no answer.`,
      });
    }
  }

  // Post-process: a Pyramid (Gradwrite's name for a Jackpot-style chain) is
  // one numbered block — a bare "11." above unnumbered "Part N:" (or
  // "Clue A:") lines — whose numbering gives it several slots (either from
  // the pack itself, or opened up by the expansion pass above). Split the
  // parts across that gap so every slot exists and shares the block's
  // answer; the last slot absorbs any extra parts.
  for (let i = 0; i < unique.length; i++) {
    const q = unique[i];
    if (!q.category || !/pyramid|jackpot/i.test(q.category) || q.streakRange) continue;
    const parts = splitPartChunks(q.question);
    if (parts.length < 2) continue;
    const nextNum = i + 1 < unique.length ? unique[i + 1].num : 101;
    const extraSlots = Math.min(nextNum - q.num - 1, parts.length - 1);
    if (extraSlots < 1) continue;
    const chunks = parts.slice(0, extraSlots);
    chunks.push(parts.slice(extraSlots).join(' '));
    q.question = chunks[0];
    const inserts = [];
    for (let s = 1; s < chunks.length; s++) {
      inserts.push({
        ...q,
        num: q.num + s,
        question: chunks[s],
        posInCategory: q.posInCategory === null ? null : q.posInCategory + s,
      });
    }
    unique.splice(i + 1, 0, ...inserts);
    i += inserts.length;
  }

  return { questions: unique, issues };
}
