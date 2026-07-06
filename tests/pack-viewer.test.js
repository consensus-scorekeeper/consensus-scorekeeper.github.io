// The pack viewer's text mode: non-PDF packs (state.packDoc) must render
// into the inline panel and the fullscreen overlay, with the PDF-specific
// controls hidden and the toggle button speaking "Pack".

import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../src/state.js';
import { parseTextPack } from '../src/parser/text-pack.js';
import { syncInlinePdfToQuestion, updateInlinePdfButton, viewPack } from '../src/ui/pdf-viewer.js';

const PACK = `Set of 2: Authors
1. Who wrote Hamlet?
A: Shakespeare
2. Who wrote 1984?
A: Orwell
`;

beforeEach(() => {
  const { questions, doc } = parseTextPack(PACK);
  state.questions = questions;
  state.currentQuestion = 0;
  state.hasQuestions = true;
  state.packDoc = doc;
  state.pdfBytes = null;
  state.inlinePdfHidden = false;
  state.pdfViewer = { doc: null, currentPage: 1, inlinePage: null };
  document.getElementById('pdf-overlay').classList.remove('open');
});

describe('inline pack viewer — text mode', () => {
  it('renders the pack text and hides the PDF controls', async () => {
    await syncInlinePdfToQuestion();
    expect(document.getElementById('inline-pdf').style.display).toBe('block');
    const textEl = document.getElementById('inline-pack-text');
    expect(textEl.style.display).not.toBe('none');
    expect(textEl.querySelectorAll('.pack-line').length).toBeGreaterThan(0);
    expect(textEl.querySelector('[data-qnum="1"]').textContent).toContain('Who wrote Hamlet?');
    expect(textEl.querySelector('.pack-line-bold').textContent).toBe('Set of 2: Authors');
    expect(document.querySelector('#inline-pdf .inline-pdf-canvas-wrap').style.display).toBe('none');
    expect(document.getElementById('inline-pdf-prev').style.display).toBe('none');
    expect(document.getElementById('inline-pdf-next').style.display).toBe('none');
  });

  it('labels the toggle button "Pack" and enables it without a PDF', async () => {
    await syncInlinePdfToQuestion();
    const btn = document.getElementById('toggle-inline-pdf-btn');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Hide Pack');
    state.inlinePdfHidden = true;
    updateInlinePdfButton();
    expect(btn.textContent).toBe('Show Pack');
  });

  it('hides the panel and disables the toggle when no pack view exists', async () => {
    state.packDoc = null;
    await syncInlinePdfToQuestion();
    expect(document.getElementById('inline-pdf').style.display).toBe('none');
    expect(document.getElementById('toggle-inline-pdf-btn').disabled).toBe(true);
  });
});

describe('fullscreen pack viewer — text mode', () => {
  it('opens the overlay with rendered text and hides the canvas/page nav', async () => {
    await viewPack();
    expect(document.getElementById('pdf-overlay').classList.contains('open')).toBe(true);
    const textEl = document.getElementById('pack-overlay-text');
    expect(textEl.style.display).not.toBe('none');
    expect(textEl.querySelectorAll('.pack-line').length).toBeGreaterThan(0);
    expect(document.getElementById('pdf-canvas').style.display).toBe('none');
    expect(document.getElementById('pdf-page-prev').style.display).toBe('none');
    expect(document.getElementById('pdf-page-next').style.display).toBe('none');
  });
});
