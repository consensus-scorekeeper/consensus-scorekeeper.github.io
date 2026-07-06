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
// (already state-resident) PDF bytes are persisted alongside the state;
// `packDoc` is the RichDoc the pack viewer renders for non-PDF formats.
function applyParseResult({ filename, questions, issues, totalSlots, isPdf, packDoc = null }) {
  state.parseIssues = issues;
  state.packDoc = packDoc;
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
  state.packDoc = null;
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

// Zip uploads: a zip may hold any mix of the supported pack formats
// (.pdf, .docx, .txt); each entry is dispatched to its format adapter.
// After the first pack loads, the remaining packs are parsed in the
// background so the dropdown can show a per-pack issue summary. The
// generation counter abandons an in-flight annotation loop when a new
// upload supersedes it; the cache lets re-selecting an annotated pack skip
// the re-parse.
let zipGeneration = 0;
let zipParseCache = new Map(); // name → { questions, issues, totalSlots } | null (parse failed)

// Which adapter a zip entry belongs to, or null for entries we don't parse
// (folders, macOS junk like __MACOSX/ and ._AppleDouble files, other types).
export function zipEntryFormat(name) {
  if (name.startsWith('__MACOSX/')) return null;
  const base = name.split('/').pop();
  if (!base || base.startsWith('.')) return null;
  const lower = base.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.txt')) return 'txt';
  return null;
}

// Parse one zip entry through its adapter + whole-pack checks, without
// touching state or the DOM (used by the background annotation).
async function parseZipEntryToResult(name, data) {
  const format = zipEntryFormat(name);
  if (format === 'pdf') return parsePdfToResult(data);
  let parsed;
  if (format === 'docx') {
    parsed = await parseDocxBuffer(data.slice(0));
  } else {
    parsed = parseTextPack(new TextDecoder('utf-8').decode(data));
  }
  const { questions, issues, doc } = parsed;
  issues.push(...analyzeQuestions(questions, { source: format }));
  return { questions, issues, totalSlots: computeTotalSlots(questions), doc };
}

// Full load of a zip entry into state (status line, persistence, report),
// via the same entry points the file picker uses.
async function loadZipEntry(name, data) {
  const format = zipEntryFormat(name);
  if (format === 'pdf') await parsePdf(data, name);
  else if (format === 'docx') await parseDocx(data.slice(0), name);
  else await parseTextFile(new TextDecoder('utf-8').decode(data), name);
}

function zipOptionLabel(name, result) {
  if (!result) return `${name} — parse failed`;
  const { errors, warns } = summarizeIssues(result.issues);
  const parts = [];
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warns) parts.push(`${warns} warning${warns === 1 ? '' : 's'}`);
  return parts.length ? `${name} — ${parts.join(', ')}` : `${name} — OK`;
}

function updateZipOptionLabel(name, result) {
  const dropdown = document.getElementById('zip-pack-dropdown');
  if (!dropdown) return;
  const opt = [...dropdown.options].find(o => o.value === name);
  if (opt) opt.textContent = zipOptionLabel(name, result);
}

async function annotateZipPacks(names, generation) {
  for (const name of names) {
    if (generation !== zipGeneration) return; // a newer upload took over
    if (zipParseCache.has(name)) continue;
    let result = null;
    try {
      result = await parseZipEntryToResult(name, state.zipPacks.get(name));
    } catch {
      result = null;
    }
    if (generation !== zipGeneration) return;
    zipParseCache.set(name, result);
    updateZipOptionLabel(name, result);
    // Yield between packs so the UI stays responsive.
    await new Promise(r => setTimeout(r, 0));
  }
}

// Selecting an already-annotated pack reuses its cached parse; only the
// state/status/persistence side has to rerun.
function applyCachedZipResult(filename, data, result) {
  setStatus('Loading cached parse...');
  state.packName = filename;
  state.parseIssues = [];
  if (state.pdfViewer) state.pdfViewer.doc = null;
  const isPdf = zipEntryFormat(filename) === 'pdf';
  if (isPdf) {
    // Copy — pdf.js detaches the buffer it renders, and the cached zip
    // entry must survive re-selection.
    state.pdfBytes = new Uint8Array(data.slice(0));
  } else {
    state.pdfBytes = null;
    clearSavedPdfBytes();
  }
  applyParseResult({ filename, questions: result.questions, issues: result.issues, totalSlots: result.totalSlots, isPdf, packDoc: isPdf ? null : (result.doc || null) });
}

export async function processZipBuffer(buffer) {
  setStatus('Reading zip file...');
  try {
    const { entries } = await readZip(buffer, (name) => !!zipEntryFormat(name));
    if (entries.length === 0) {
      setStatus('No .pdf, .docx, or .txt packs found in zip.', 'error');
      return;
    }
    zipGeneration++;
    zipParseCache = new Map();
    const generation = zipGeneration;
    state.zipPacks = new Map();
    for (const entry of entries) {
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
        if (!data) return;
        const cached = zipParseCache.get(selected);
        if (cached) applyCachedZipResult(selected, data, cached);
        else await loadZipEntry(selected, data);
      };
    }
    if (selectDiv) selectDiv.style.display = 'block';
    await loadZipEntry(names[0], state.zipPacks.get(names[0]));
    // Fire-and-forget: annotate every pack (including the first, so its
    // label gets a verdict too) without blocking the upload flow.
    annotateZipPacks(names, generation);
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
    const { questions, issues, doc } = await parseFn();
    issues.push(...analyzeQuestions(questions, { source }));
    applyParseResult({ filename, questions, issues, totalSlots: computeTotalSlots(questions), isPdf: false, packDoc: doc || null });
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
