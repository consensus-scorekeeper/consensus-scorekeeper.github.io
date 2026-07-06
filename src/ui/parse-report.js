// Renders the "suspected parsing issues" panel under the upload status on
// the setup screen, from state.parseIssues. Safe to call on pages without
// the panel (no-op) and with an empty issue list (hides the panel).

import { state } from '../state.js';
import { escapeHtml } from '../util/escape.js';
import { summarizeIssues, shouldNudgeFormatPack } from '../parser/diagnostics.js';

export function renderParseReport() {
  const panel = document.getElementById('parse-report');
  if (!panel) return;
  const issues = state.parseIssues || [];
  if (issues.length === 0) {
    panel.style.display = 'none';
    panel.open = false;
    return;
  }

  const { errors, warns } = summarizeIssues(issues);
  const parts = [];
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warns) parts.push(`${warns} warning${warns === 1 ? '' : 's'}`);
  const summaryEl = document.getElementById('parse-report-summary');
  if (summaryEl) summaryEl.textContent = `⚠ Suspected parsing issues: ${parts.join(', ')}`;

  const listEl = document.getElementById('parse-report-list');
  if (listEl) {
    listEl.innerHTML = issues.map(issue => {
      const where = issue.lineNo ? `line ${issue.lineNo}: ` : '';
      const snippet = issue.snippet ? ` <code>${escapeHtml(issue.snippet)}</code>` : '';
      return `<li class="${issue.severity === 'error' ? 'error' : 'warn'}">` +
        `${escapeHtml(where)}${escapeHtml(issue.message)}${snippet}</li>`;
    }).join('');
  }

  const nudgeEl = document.getElementById('parse-report-nudge');
  if (nudgeEl) nudgeEl.style.display = shouldNudgeFormatPack(issues) ? '' : 'none';

  panel.style.display = '';
}
