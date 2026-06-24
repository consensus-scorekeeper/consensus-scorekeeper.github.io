// "Format your own pack" modal. Lets users convert raw questions into the
// scorekeeper text-pack format with the help of an external LLM:
//
//   Step 1 — Paste raw questions, click "Copy LLM prompt". The prompt
//            template from assets/text-pack-llm-prompt.txt is fetched once,
//            the user's raw text is inlined into its
//            "{paste your raw questions here}" placeholder, and the result
//            goes onto the clipboard.
//   Step 2 — Paste the LLM's reformatted output and click "Load pack" to
//            run it through parseTextFile and start a session.
//
// The prompt itself owns the injection-resistance instructions; this module
// only orchestrates clipboard + load.

import { parseTextFile } from '../loader.js';
import { state } from '../state.js';

const PROMPT_URL = 'assets/text-pack-llm-prompt.txt';
const RAW_PLACEHOLDER = '{paste your raw questions here}';

let cachedPromptTemplate = null;

async function getPromptTemplate() {
  if (cachedPromptTemplate) return cachedPromptTemplate;
  const res = await fetch(PROMPT_URL);
  if (!res.ok) throw new Error(`Could not load prompt template (${res.status})`);
  cachedPromptTemplate = await res.text();
  return cachedPromptTemplate;
}

function setStatus(el, message, kind) {
  if (!el) return;
  el.textContent = message;
  el.className = 'format-modal-status' + (kind ? ' ' + kind : '');
}

export function openFormatPack() {
  const modal = document.getElementById('format-modal');
  if (!modal) return;
  modal.classList.add('open');
  setStatus(document.getElementById('format-copy-status'), '');
  setStatus(document.getElementById('format-load-status'), '');
  const raw = document.getElementById('format-raw');
  if (raw) setTimeout(() => raw.focus(), 0);
}

export function closeFormatPack() {
  const modal = document.getElementById('format-modal');
  if (modal) modal.classList.remove('open');
}

async function copyPrompt() {
  const status = document.getElementById('format-copy-status');
  const rawEl = document.getElementById('format-raw');
  const raw = (rawEl && rawEl.value || '').trim();
  if (!raw) {
    setStatus(status, 'Paste raw questions in Step 1 first.', 'error');
    return;
  }
  try {
    const tmpl = await getPromptTemplate();
    // The placeholder appears exactly once in the template; if a future edit
    // removes it, fall back to appending the raw content so the prompt is
    // still usable.
    const filled = tmpl.includes(RAW_PLACEHOLDER)
      ? tmpl.replace(RAW_PLACEHOLDER, raw)
      : `${tmpl}\n\n<<<PACK_BEGIN>>>\n${raw}\n<<<PACK_END>>>\n`;
    await navigator.clipboard.writeText(filled);
    setStatus(status, 'Prompt copied — paste into Claude / ChatGPT / etc.', 'success');
  } catch (err) {
    setStatus(status, 'Copy failed: ' + err.message, 'error');
  }
}

async function loadPack() {
  const status = document.getElementById('format-load-status');
  const outEl = document.getElementById('format-output');
  const text = (outEl && outEl.value || '').trim();
  if (!text) {
    setStatus(status, 'Paste the LLM output in Step 2 first.', 'error');
    return;
  }
  setStatus(status, 'Parsing...');
  await parseTextFile(text, 'custom-pack.txt');
  // parseTextFile writes its own status into #pdf-status; mirror it here.
  // Close the modal only when the pack actually loaded — leave it open on
  // parse failure so the user can fix the input.
  const pdfStatus = document.getElementById('pdf-status');
  const msg = pdfStatus ? pdfStatus.textContent : (state.hasQuestions ? 'Loaded.' : 'Failed to parse.');
  setStatus(status, msg, state.hasQuestions ? 'success' : 'error');
  if (state.hasQuestions) closeFormatPack();
}

export function setupFormatPack() {
  const modal = document.getElementById('format-modal');
  if (!modal) return;
  // Backdrop click closes; clicks inside the card don't bubble out.
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeFormatPack();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeFormatPack();
  });
}

export const formatPackActions = {
  'open-format-pack': () => openFormatPack(),
  'close-format-pack': () => closeFormatPack(),
  'copy-format-prompt': () => copyPrompt(),
  'load-format-pack': () => loadPack(),
};
