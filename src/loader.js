// Orchestrates loading a PDF (or a zip-of-PDFs) into state. Calls the pure
// parser modules and writes the results into `state`. The status messages
// the user sees come from this module too — kept here rather than in a UI
// module because every entry path (file picker, zip upload, online pack
// browser, dropdown selection) goes through the same status element.

import { state } from './state.js';
import { escapeHtml } from './util/escape.js';
import { readZip } from './parser/zip.js';
import { extractRichLinesFromPdf } from './parser/pdf-text.js';
import { parseQuestions } from './parser/questions.js';
import { parseDocxBuffer } from './parser/docx-questions.js';
import { parseTextPack } from './parser/text-pack.js';
import { saveState, savePdfBytes, clearSavedPdfBytes } from './game/persistence.js';

export async function parsePdf(arrayBuffer, filename) {
  const statusEl = document.getElementById('pdf-status');
  if (statusEl) {
    statusEl.textContent = 'Parsing PDF...';
    statusEl.className = 'pdf-status';
  }
  state.packName = filename || null;
  if (state.pdfViewer) state.pdfViewer.doc = null; // invalidate cached viewer doc
  try {
    // pdf.js detaches the ArrayBuffer it's given. Clone for parsing AND
    // keep a separate Uint8Array copy in state so we can re-render pages
    // for the "View PDF" overlay later.
    const dataCopy = arrayBuffer.slice(0);
    state.pdfBytes = new Uint8Array(arrayBuffer.slice(0));
    const pdf = await window.pdfjsLib.getDocument({ data: dataCopy }).promise;

    const { lines, combined, richSegments, posMap, lineStartPositions } =
      await extractRichLinesFromPdf(pdf);
    const questions = parseQuestions(lines, combined, richSegments, posMap, lineStartPositions);
    // pageNum and yPos are set inside parseQuestions (using exact question
    // positions, not indexOf which collides with substrings like "1. " inside "11. ").
    const totalSlots = questions.reduce((sum, q) => {
      if (q.streakRange) return sum + (q.streakRange.end - q.streakRange.start + 1);
      return sum + 1;
    }, 0);
    if (questions.length >= 10) {
      state.questions = questions;
      state.hasQuestions = true;
      if (statusEl) {
        const cls = totalSlots === 100 ? 'success' : 'warn';
        statusEl.textContent = `Parsed ${questions.length} questions (${totalSlots} slots) from "${filename}".` +
          (totalSlots !== 100 ? ` (Expected 100)` : '');
        statusEl.className = `pdf-status ${cls}`;
      }
      savePdfBytes(state.pdfBytes);
      saveState();
    } else {
      state.questions = [];
      state.hasQuestions = false;
      if (statusEl) {
        statusEl.textContent = `Could not parse questions from "${filename}" (found ${questions.length}). Will use numbered tracking.`;
        statusEl.className = 'pdf-status warn';
      }
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = 'Error parsing PDF: ' + err.message;
      statusEl.className = 'pdf-status error';
    }
    state.questions = [];
    state.hasQuestions = false;
  }
}

export async function processZipBuffer(buffer) {
  const statusEl = document.getElementById('pdf-status');
  if (statusEl) {
    statusEl.textContent = 'Reading zip file...';
    statusEl.className = 'pdf-status';
  }
  try {
    const { entries } = await readZip(buffer);
    const pdfEntries = entries.filter(e => e.name.endsWith('.pdf'));
    if (pdfEntries.length === 0) {
      if (statusEl) {
        statusEl.textContent = 'No PDF files found in zip.';
        statusEl.className = 'pdf-status error';
      }
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
    if (statusEl) {
      statusEl.textContent = 'Error reading zip: ' + err.message;
      statusEl.className = 'pdf-status error';
    }
  }
}

export async function handleZipUpload(file) {
  await processZipBuffer(await file.arrayBuffer());
}

// Shared post-parse handler for the non-PDF upload paths (.docx, .txt).
// Writes the result into state, updates the status message, and saves on
// success. `errorPrefix` is the label used if `parseFn()` throws.
async function applyTextPackResult({ filename, parseFn, parsingMessage, errorPrefix }) {
  const statusEl = document.getElementById('pdf-status');
  if (statusEl) {
    statusEl.textContent = parsingMessage;
    statusEl.className = 'pdf-status';
  }
  state.packName = filename || null;
  // No PDF backs this pack — clear any prior bytes so the inline viewer
  // doesn't try to render a stale doc from a previous session, and clear
  // the persisted copy so a reload doesn't resurrect it.
  state.pdfBytes = null;
  if (state.pdfViewer) state.pdfViewer.doc = null;
  clearSavedPdfBytes();
  try {
    const questions = await parseFn();
    const totalSlots = questions.reduce((sum, q) => {
      if (q.streakRange) return sum + (q.streakRange.end - q.streakRange.start + 1);
      return sum + 1;
    }, 0);
    if (questions.length >= 10) {
      state.questions = questions;
      state.hasQuestions = true;
      if (statusEl) {
        const cls = totalSlots === 100 ? 'success' : 'warn';
        statusEl.textContent = `Parsed ${questions.length} questions (${totalSlots} slots) from "${filename}".` +
          (totalSlots !== 100 ? ` (Expected 100)` : '');
        statusEl.className = `pdf-status ${cls}`;
      }
      saveState();
    } else {
      state.questions = [];
      state.hasQuestions = false;
      if (statusEl) {
        statusEl.textContent = `Could not parse questions from "${filename}" (found ${questions.length}).`;
        statusEl.className = 'pdf-status warn';
      }
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `${errorPrefix}: ${err.message}`;
      statusEl.className = 'pdf-status error';
    }
    state.questions = [];
    state.hasQuestions = false;
  }
}

export async function parseDocx(arrayBuffer, filename) {
  await applyTextPackResult({
    filename,
    parseFn: () => parseDocxBuffer(arrayBuffer),
    parsingMessage: 'Parsing Word document...',
    errorPrefix: 'Error parsing .docx',
  });
}

export async function parseTextFile(text, filename) {
  await applyTextPackResult({
    filename,
    parseFn: () => parseTextPack(text),
    parsingMessage: 'Parsing text pack...',
    errorPrefix: 'Error parsing text pack',
  });
}
