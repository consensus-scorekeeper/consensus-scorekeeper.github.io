// Inline + fullscreen pack viewer. PDFs render via pdf.js (both modes share
// the document loaded into state.pdfViewer.doc, lazy-loaded the first time
// either mode is opened). Non-PDF packs (.docx/.txt) render state.packDoc —
// the RichDoc the pack parsed from — as formatted text. Either way, the
// inline viewer auto-follows the current question.

import { state } from '../state.js';
import { saveState } from '../game/persistence.js';
import { escapeHtml } from '../util/escape.js';

const hasPackView = () => !!state.pdfBytes || !!state.packDoc;
// Text mode = a non-PDF pack is loaded. (A PDF always wins if present.)
const isTextPack = () => !state.pdfBytes && !!state.packDoc;

// ==================== text-pack rendering ====================

// Track which packDoc each container has rendered so pack switches (zip
// dropdown, re-upload) re-render but question navigation doesn't.
let inlineRenderedDoc = null;
let overlayRenderedDoc = null;

function packLineHtml(line) {
  const qm = line.text.match(/^(\d{1,3})\.\s/);
  const classes = ['pack-line'];
  if (line.isBold) classes.push('pack-line-bold');
  else if (qm) classes.push('pack-line-q');
  else if (/^A:/.test(line.text)) classes.push('pack-line-a');
  const runs = line.segments && line.segments.length ? line.segments : [{ text: line.text, bold: line.isBold }];
  // Fully-bold lines are category headers — styled by class, not per-run
  // markup. Bold runs inside normal lines are answer highlights.
  const html = runs.map(r =>
    (r.bold && !line.isBold) ? `<b><u>${escapeHtml(r.text)}</u></b>` : escapeHtml(r.text)
  ).join('');
  return `<div class="${classes.join(' ')}"${qm ? ` data-qnum="${qm[1]}"` : ''}>${html}</div>`;
}

function packDocHtml(doc) {
  return doc.lines.map(packLineHtml).join('');
}

// Scroll a rendered pack-text container so the current question sits near
// the top. Streak slots share the streak source question's line.
function scrollTextToQuestion(container, q) {
  if (!container) return;
  if (!q) { container.scrollTop = 0; return; }
  let num = q.num;
  if (q.isStreak && q.streakGroupStart != null && state.questions[q.streakGroupStart]) {
    num = state.questions[q.streakGroupStart].num;
  }
  let target = container.querySelector(`[data-qnum="${num}"]`);
  if (!target) {
    // Fall back to the nearest preceding question line (padded gap slots
    // have no line of their own).
    let best = null;
    for (const el of container.querySelectorAll('[data-qnum]')) {
      const n = parseInt(el.dataset.qnum, 10);
      if (n <= num) best = el;
      else break;
    }
    target = best;
  }
  container.scrollTop = target ? Math.max(0, target.offsetTop - 8) : 0;
}

// Show/hide the PDF-specific vs text-specific children of the inline panel.
function setInlineMode(textMode) {
  const wrap = document.querySelector('#inline-pdf .inline-pdf-canvas-wrap');
  const textEl = document.getElementById('inline-pack-text');
  const prev = document.getElementById('inline-pdf-prev');
  const next = document.getElementById('inline-pdf-next');
  const label = document.getElementById('inline-pdf-label');
  if (wrap) wrap.style.display = textMode ? 'none' : '';
  if (textEl) textEl.style.display = textMode ? '' : 'none';
  if (prev) prev.style.display = textMode ? 'none' : '';
  if (next) next.style.display = textMode ? 'none' : '';
  if (label && textMode) label.textContent = 'Pack text';
}

function setOverlayMode(textMode) {
  const canvas = document.getElementById('pdf-canvas');
  const textEl = document.getElementById('pack-overlay-text');
  const prev = document.getElementById('pdf-page-prev');
  const next = document.getElementById('pdf-page-next');
  const label = document.getElementById('pdf-page-label');
  if (canvas) canvas.style.display = textMode ? 'none' : '';
  if (textEl) textEl.style.display = textMode ? '' : 'none';
  if (prev) prev.style.display = textMode ? 'none' : '';
  if (next) next.style.display = textMode ? 'none' : '';
  if (label) label.textContent = textMode ? 'Pack text' : label.textContent;
}

// ==================== pdf.js plumbing ====================

// Lazily loads the pdf.js document on demand. Both viewers share it.
async function ensurePdfLoaded() {
  if (state.pdfViewer.doc) return state.pdfViewer.doc;
  if (!state.pdfBytes) return null;
  // window.pdfjsLib is set by a deferred module script in index.html, which
  // may not have finished running on the very first call (e.g., if loadState
  // restores a session before pdf.js has loaded). Wait on the readiness
  // promise that script publishes.
  if (window.pdfjsReady) await window.pdfjsReady;
  const dataCopy = state.pdfBytes.slice().buffer;
  state.pdfViewer.doc = await window.pdfjsLib.getDocument({ data: dataCopy }).promise;
  return state.pdfViewer.doc;
}

export async function viewPack() {
  if (!hasPackView()) {
    alert('No pack loaded — upload or browse a packet first.');
    return;
  }
  const overlay = document.getElementById('pdf-overlay');
  if (isTextPack()) {
    setOverlayMode(true);
    const textEl = document.getElementById('pack-overlay-text');
    if (textEl && overlayRenderedDoc !== state.packDoc) {
      textEl.innerHTML = packDocHtml(state.packDoc);
      overlayRenderedDoc = state.packDoc;
    }
    overlay.classList.add('open');
    scrollTextToQuestion(textEl, state.questions[state.currentQuestion]);
    return;
  }
  setOverlayMode(false);
  await ensurePdfLoaded();
  // Open at whichever page the inline viewer is showing, if any.
  const targetPage = state.pdfViewer.inlinePage
    || state.pdfViewer.currentPage
    || (state.questions[state.currentQuestion] && state.questions[state.currentQuestion].pageNum)
    || 1;
  overlay.classList.add('open');
  await renderPdfPage(targetPage);
}

export async function renderPdfPage(pageNum) {
  const doc = state.pdfViewer.doc;
  if (!doc) return;
  if (pageNum < 1) pageNum = 1;
  if (pageNum > doc.numPages) pageNum = doc.numPages;
  state.pdfViewer.currentPage = pageNum;
  const page = await doc.getPage(pageNum);
  const scale = Math.min(2, (window.innerHeight - 100) / page.getViewport({ scale: 1 }).height);
  const viewport = page.getViewport({ scale: Math.max(1.2, scale) });
  const canvas = document.getElementById('pdf-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: ctx, viewport }).promise;
  document.getElementById('pdf-page-label').textContent = `Page ${pageNum} / ${doc.numPages}`;
  document.getElementById('pdf-page-prev').disabled = pageNum <= 1;
  document.getElementById('pdf-page-next').disabled = pageNum >= doc.numPages;
}

export function closePdfViewer() {
  document.getElementById('pdf-overlay').classList.remove('open');
  if (isTextPack()) return;
  // Sync the inline viewer to wherever the fullscreen ended up.
  const last = state.pdfViewer.currentPage;
  if (last && last !== state.pdfViewer.inlinePage) renderInlinePdf(last);
}

// Renders pageNum into the inline canvas, scaled to fit the inline width.
// Called from renderQuestion (auto-follow) and the inline page nav buttons.
export async function renderInlinePdf(pageNum) {
  const inline = document.getElementById('inline-pdf');
  if (!inline) return;
  const doc = await ensurePdfLoaded();
  if (!doc) {
    inline.style.display = 'none';
    return;
  }
  inline.style.display = 'block';
  if (pageNum < 1) pageNum = 1;
  if (pageNum > doc.numPages) pageNum = doc.numPages;
  state.pdfViewer.inlinePage = pageNum;
  const page = await doc.getPage(pageNum);
  const wrap = inline.querySelector('.inline-pdf-canvas-wrap');
  const targetW = Math.max(300, (wrap && wrap.clientWidth ? wrap.clientWidth : 600) - 4);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = targetW / baseViewport.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.getElementById('inline-pdf-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: ctx, viewport }).promise;
  document.getElementById('inline-pdf-label').textContent = `Page ${pageNum} / ${doc.numPages}`;
  document.getElementById('inline-pdf-prev').disabled = pageNum <= 1;
  document.getElementById('inline-pdf-next').disabled = pageNum >= doc.numPages;
  // Save scale + base height so syncInlinePdfToQuestion can convert PDF-y to canvas-y.
  state.pdfViewer.inlineScale = scale;
  state.pdfViewer.inlineBaseHeight = baseViewport.height;
  if (wrap) wrap.scrollTop = 0;
}

// Scroll the inline wrap so the current question's text is near the top.
// PDF y-coordinates are bottom-up; canvas y is top-down — convert via the
// page height (in PDF units) and the render scale.
function scrollInlineToQuestion(q) {
  const wrap = document.querySelector('#inline-pdf .inline-pdf-canvas-wrap');
  if (!wrap) return;
  if (!q || typeof q.yPos !== 'number') {
    wrap.scrollTop = 0;
    return;
  }
  const baseH = state.pdfViewer.inlineBaseHeight;
  const scale = state.pdfViewer.inlineScale;
  if (!baseH || !scale) { wrap.scrollTop = 0; return; }
  // q.yPos is the PDF baseline (text bottom). Glyphs extend up from there.
  // Subtract ~30px so the full line + a bit of context above sits below the
  // top of the visible area instead of being clipped.
  const canvasY = (baseH - q.yPos) * scale;
  wrap.scrollTop = Math.max(0, canvasY - 30);
}

// Auto-follow the current question in the inline viewer.
export async function syncInlinePdfToQuestion() {
  const inline = document.getElementById('inline-pdf');
  if (!hasPackView() || state.inlinePdfHidden) {
    if (inline) inline.style.display = 'none';
    updateInlinePdfButton();
    return;
  }
  const q = state.questions[state.currentQuestion];
  if (isTextPack()) {
    if (inline) inline.style.display = 'block';
    setInlineMode(true);
    const textEl = document.getElementById('inline-pack-text');
    if (textEl && inlineRenderedDoc !== state.packDoc) {
      textEl.innerHTML = packDocHtml(state.packDoc);
      inlineRenderedDoc = state.packDoc;
    }
    scrollTextToQuestion(textEl, q);
    updateInlinePdfButton();
    return;
  }
  setInlineMode(false);
  const target = (q && q.pageNum) || 1;
  if (state.pdfViewer.inlinePage !== target) await renderInlinePdf(target);
  scrollInlineToQuestion(q);
  updateInlinePdfButton();
}

// Sync the controls-bar toggle button label and disabled state.
export function updateInlinePdfButton() {
  const btn = document.getElementById('toggle-inline-pdf-btn');
  if (!btn) return;
  btn.disabled = !hasPackView();
  btn.textContent = state.inlinePdfHidden ? 'Show Pack' : 'Hide Pack';
}

export function toggleInlinePdf() {
  state.inlinePdfHidden = !state.inlinePdfHidden;
  if (state.inlinePdfHidden) {
    const inline = document.getElementById('inline-pdf');
    if (inline) inline.style.display = 'none';
    updateInlinePdfButton();
  } else {
    // Force a re-render of the current question's page on re-show.
    state.pdfViewer.inlinePage = null;
    syncInlinePdfToQuestion();
  }
  saveState();
}

// Handlers for the inline + fullscreen viewers' nav buttons. Wired up by
// the data-action dispatcher in main.js (e.g., data-action="pdf-page-next").
export const pdfPagePrev = () => renderPdfPage(state.pdfViewer.currentPage - 1);
export const pdfPageNext = () => renderPdfPage(state.pdfViewer.currentPage + 1);
export const inlinePdfPrev = () => renderInlinePdf((state.pdfViewer.inlinePage || 1) - 1);
export const inlinePdfNext = () => renderInlinePdf((state.pdfViewer.inlinePage || 1) + 1);

export function setupPdfViewer() {
  // Esc + arrow keys inside the fullscreen overlay. Page nav is a no-op in
  // text mode (renderPdfPage bails when no pdf.js doc is loaded).
  document.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('pdf-overlay');
    if (!overlay || !overlay.classList.contains('open')) return;
    if (e.key === 'Escape') { e.preventDefault(); closePdfViewer(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pdfPageNext(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); pdfPagePrev(); }
  });
}
