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
  text = text.replace(/\s+(?:Set of \d+.*|Splits?:.*|PACK \d+.*|Streaks?.*|Streak)$/i, '');
  return text.trim();
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
  let currentCategory = null;
  let currentInstructions = '';   // accumulated prose between a category title and its first question
  let captureInstructions = false; // toggled true after a bold category title; false on first qMatch
  let categoryQuestionCount = 0;
  let inSplit = false;
  let splitCount = 0;

  for (const line of lines) {
    const text = line.text;
    // Question line (starts with "N.")
    const qMatch = text.match(/^(\d{1,3})\.\s/);
    if (qMatch) {
      const num = parseInt(qMatch[1]);
      if (num >= 1 && num <= 100 && currentCategory) {
        categoryQuestionCount++;
        categoryMap[num] = {
          category: currentCategory,
          posInCategory: categoryQuestionCount,
          categoryInstructions: currentInstructions || null,
        };
      }
      captureInstructions = false;
      continue;
    }
    // Skip structural markers (END OF, QUARTER labels, etc.)
    if (STRUCTURAL_RE.test(text) || text.length < 2) continue;
    // Skip answer/accept/prompt/reject lines
    if (/^(A:\s|\(accept|\(prompt|\(reject)/i.test(text)) continue;
    // Skip quarter/half markers (page headers — always uppercase in real PDFs).
    if (/^(QUARTER|HALF)/.test(text)) continue;
    // Skip bare numbers
    if (/^\d+$/.test(text.trim())) continue;

    // Detect "Splits:" header — next bold lines are numbered sub-categories
    if (/^Splits?:/i.test(text)) {
      inSplit = true;
      splitCount = 0;
      captureInstructions = false;
      currentInstructions = '';
      continue;
    }

    // A bold line after an answer = category title
    if (line.isBold) {
      if (inSplit) {
        // Sub-category within a split
        splitCount++;
        currentCategory = `Splits ${splitCount}: ${text}`;
      } else {
        currentCategory = text;
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
    // explains the answer format before Q63). Otherwise ignore.
    if (captureInstructions) {
      currentInstructions = (currentInstructions ? currentInstructions + ' ' : '') + text;
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

  const questions = [];
  for (let i = 0; i < questionStarts.length; i++) {
    const start = questionStarts[i];
    const endPos = i + 1 < questionStarts.length ? questionStarts[i + 1].pos : combined.length;
    const segment = combined.substring(start.pos, endPos);
    const catInfo = categoryMap[start.num] || null;
    const nextTitle = nextCategoryTitle(i, catInfo);
    // Look up source page + Y position from the rich segment that contains this
    // question's "N. " marker. Used to scroll the inline PDF to the question.
    let qPageNum = null, qYPos = null;
    if (posMap[start.pos]) {
      const seg = richSegments[posMap[start.pos].segIdx];
      if (seg) { qPageNum = seg.page || null; qYPos = (typeof seg.y === 'number') ? seg.y : null; }
    }

    const aMatch = segment.match(/\bA:\s*(.*)/);
    if (aMatch) {
      const qMatch = segment.match(/^\d{1,3}\.\s+([\s\S]*?)\s*\bA:\s*/);
      if (qMatch) {
        const questionText = qMatch[1].trim().replace(/\s+/g, ' ');

        // Find where "A:" starts in the combined string for this question
        const aIdx = segment.indexOf('A:');
        const answerStartInCombined = start.pos + aIdx + 2; // skip "A:"
        // Skip whitespace after "A:"
        let ansStart = answerStartInCombined;
        while (ansStart < endPos && combined[ansStart] === ' ') ansStart++;

        // Get rich answer segments
        let answerRich = extractRichRange(ansStart, endPos, richSegments, posMap);

        // Also get plain answer for cleaning
        let answerPlain = combined.substring(ansStart, endPos).trim().replace(/\s+/g, ' ');
        answerPlain = stripTrailingTitle(cleanTrailing(answerPlain), nextTitle);

        // Check for multiple A: answers (common in streaks)
        const aMatches = [];
        let aSearchFrom = 0;
        while (true) {
          const aPos = segment.indexOf('A:', aSearchFrom);
          if (aPos === -1) break;
          aMatches.push(aPos);
          aSearchFrom = aPos + 2;
        }
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
            let plainText = cleanTrailing(combined.substring(as2, aEnd).trim().replace(/\s+/g, ' '));
            if (ai === aMatches.length - 1) plainText = stripTrailingTitle(plainText, nextTitle);
            // Trim rich HTML to match cleaned plain text length
            const cleanLen = plainText.length;
            let tLen = 0;
            const trimmed = [];
            for (const seg of rich) {
              if (tLen >= cleanLen) break;
              const rem = cleanLen - tLen;
              if (seg.str.length <= rem) { trimmed.push(seg); tLen += seg.str.length; }
              else { trimmed.push({ str: seg.str.substring(0, rem), bold: seg.bold }); tLen += rem; }
            }
            htmlParts.push(richToHtml(trimmed));
            plainParts.push(plainText);
          }
          answerHtml = htmlParts.map(h => `<div>Answer: ${h}</div>`).join('');
          answerPlain = plainParts.join(' | ');
        } else {
          // Trim the rich segments to match cleaned plain text length
          // Remove trailing section headers from rich segments
          const cleanLen = answerPlain.length;
          let totalLen = 0;
          const trimmedRich = [];
          for (const seg of answerRich) {
            if (totalLen >= cleanLen) break;
            const remaining = cleanLen - totalLen;
            if (seg.str.length <= remaining) {
              trimmedRich.push(seg);
              totalLen += seg.str.length;
            } else {
              trimmedRich.push({ str: seg.str.substring(0, remaining), bold: seg.bold });
              totalLen += remaining;
            }
          }
          answerHtml = richToHtml(trimmedRich);
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
          const isStreakQ = !!(catInfo && catInfo.category && /streak/i.test(catInfo.category));
          // For streaks, calculate the range of question numbers this streak covers
          // (from this Q's number to next Q's number - 1)
          let streakEnd = null;
          if (isStreakQ && i + 1 < questionStarts.length) {
            streakEnd = questionStarts[i + 1].num - 1;
          } else if (isStreakQ) {
            streakEnd = 100; // last question
          }
          questions.push({
            num: start.num,
            question: cleanTrailing(questionText),
            answer: answerPlain,
            answerHtml,
            category: catInfo ? catInfo.category : null,
            posInCategory: catInfo ? catInfo.posInCategory : null,
            categoryInstructions: catInfo ? (catInfo.categoryInstructions || null) : null,
            streakRange: isStreakQ ? { start: start.num, end: streakEnd } : null,
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
    } else {
      issues.push({
        code: 'duplicate-number', severity: 'warn', slot: q.num,
        snippet: q.question.slice(0, 80),
        message: `Question ${q.num} appears more than once — the duplicate was dropped.`,
      });
    }
  }
  unique.sort((a, b) => a.num - b.num);

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

  return { questions: unique, issues };
}
