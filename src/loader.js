// Orchestrates loading a packet into state. Every format (.pdf, zip of
// PDFs, .docx, .txt) funnels through the same universal parser
// (parser/questions.js) via its format adapter, and every path lands in the
// single applyParseResult() below — one acceptance gate, one status
// message, one parse-issue report. The status messages the user sees come
// from this module too, because every entry path (file picker, zip upload,
// online pack browser, dropdown selection) shares the same status element.

import { state } from './state.js';
import { escapeHtml } from './util/escape.js';
import { readZip } from './parser/zip.js';
import { extractRichDocFromPdf } from './parser/pdf-text.js';
import { parseQuestions, computeTotalSlots } from './parser/questions.js';
import { analyzeQuestions, summarizeIssues } from './parser/diagnostics.js';
import { parseDocxBuffer } from './parser/docx-questions.js';
import { parseTextPack } from './parser/text-pack.js';
import { renderParseReport } from './ui/parse-report.js';
import { saveState, savePdfBytes, clearSavedPdfBytes } from './game/persistence.js';

function setStatus(text, cls = '') {
  const statusEl = document.getElementById('pdf-status');
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = cls ? `pdf-status ${cls}` : 'pdf-status';
}

// Parse a PDF buffer through adapter + core + whole-pack checks without
// touching state or the DOM. Also used by the zip background annotation.
export async function parsePdfToResult(arrayBuffer) {
  // pdf.js detaches the ArrayBuffer it's given — hand it a copy.
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const { doc, adapterIssues } = await extractRichDocFromPdf(pdf);
  const { questions, issues: coreIssues } = parseQuestions(doc);
  const issues = [...adapterIssues, ...coreIssues, ...analyzeQuestions(questions, { source: 'pdf' })];
  return { questions, issues, totalSlots: computeTotalSlots(questions) };
}

// Single post-parse path for every format: acceptance gate, state writes,
// status message, parse report, persistence. `isPdf` controls whether the
// (already state-resident) PDF bytes are persisted alongside the state.
function applyParseResult({ filename, questions, issues, totalSlots, isPdf }) {
  state.parseIssues = issues;
  if (questions.length >= 10) {
    state.questions = questions;
    state.hasQuestions = true;
    const { errors, warns } = summarizeIssues(issues);
    const cls = errors ? 'error' : warns ? 'warn' : 'success';
    const issueCount = errors + warns;
    setStatus(
      `Parsed ${questions.length} questions (${totalSlots} slots) from "${filename}".` +
      (issueCount ? ` ${issueCount} suspected parsing issue${issueCount === 1 ? '' : 's'} — see report below.` : ''),
      cls
    );
    if (isPdf && state.pdfBytes) savePdfBytes(state.pdfBytes);
    saveState();
  } else {
    state.questions = [];
    state.hasQuestions = false;
    setStatus(`Could not parse questions from "${filename}" (found ${questions.length}). Will use numbered tracking.`, 'warn');
  }
  renderParseReport();
}

// A thrown parse error still produces a report entry so the panel is never
// stale relative to the status line.
function applyParseFailure(message) {
  state.questions = [];
  state.hasQuestions = false;
  state.parseIssues = [{ code: 'exception', severity: 'error', message }];
  setStatus(message, 'error');
  renderParseReport();
}

export async function parsePdf(arrayBuffer, filename) {
  setStatus('Parsing PDF...');
  state.packName = filename || null;
  state.parseIssues = [];
  if (state.pdfViewer) state.pdfViewer.doc = null; // invalidate cached viewer doc
  try {
    // Keep a Uint8Array copy in state so the "View PDF" overlay can
    // re-render pages later (parsePdfToResult clones again for pdf.js).
    state.pdfBytes = new Uint8Array(arrayBuffer.slice(0));
    const result = await parsePdfToResult(arrayBuffer);
    applyParseResult({ filename, ...result, isPdf: true });
  } catch (err) {
    applyParseFailure('Error parsing PDF: ' + err.message);
  }
}

export async function processZipBuffer(buffer) {
  setStatus('Reading zip file...');
  try {
    const { entries } = await readZip(buffer);
    const pdfEntries = entries.filter(e => e.name.endsWith('.pdf'));
    if (pdfEntries.length === 0) {
      setStatus('No PDF files found in zip.', 'error');
      return;
    }
    state.zipPacks = new Map();
    for (const entry of pdfEntries) {
      state.zipPacks.set(entry.name, entry.data);
    }
    const names = [...state.zipPacks.keys()].sort();
    const selectDiv = document.getElementById('zip-pack-select');
    const dropdown = document.getElementById('zip-pack-dropdown');
    if (dropdown) {
      dropdown.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
      dropdown.onchange = async () => {
        const selected = dropdown.value;
        const data = state.zipPacks.get(selected);
        if (data) await parsePdf(data, selected);
      };
    }
    if (selectDiv) selectDiv.style.display = 'block';
    await parsePdf(state.zipPacks.get(names[0]), names[0]);
  } catch (err) {
    setStatus('Error reading zip: ' + err.message, 'error');
  }
}

export async function handleZipUpload(file) {
  await processZipBuffer(await file.arrayBuffer());
}

// Shared entry for the non-PDF upload paths (.docx, .txt): clear any prior
// PDF (these packs have no backing PDF for the inline viewer), run the
// adapter, and hand off to the shared applyParseResult.
async function parseTextual({ filename, parseFn, parsingMessage, errorPrefix, source }) {
  setStatus(parsingMessage);
  state.packName = filename || null;
  state.parseIssues = [];
  // No PDF backs this pack — clear any prior bytes so the inline viewer
  // doesn't try to render a stale doc from a previous session, and clear
  // the persisted copy so a reload doesn't resurrect it.
  state.pdfBytes = null;
  if (state.pdfViewer) state.pdfViewer.doc = null;
  clearSavedPdfBytes();
  try {
    const { questions, issues } = await parseFn();
    issues.push(...analyzeQuestions(questions, { source }));
    applyParseResult({ filename, questions, issues, totalSlots: computeTotalSlots(questions), isPdf: false });
  } catch (err) {
    applyParseFailure(`${errorPrefix}: ${err.message}`);
  }
}

export async function parseDocx(arrayBuffer, filename) {
  await parseTextual({
    filename,
    parseFn: () => parseDocxBuffer(arrayBuffer),
    parsingMessage: 'Parsing Word document...',
    errorPrefix: 'Error parsing .docx',
    source: 'docx',
  });
}

export async function parseTextFile(text, filename) {
  await parseTextual({
    filename,
    parseFn: () => parseTextPack(text),
    parsingMessage: 'Parsing text pack...',
    errorPrefix: 'Error parsing text pack',
    source: 'txt',
  });
}
