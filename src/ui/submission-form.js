// In-page results-submission modal — the relay-backed replacement for
// "go fill in the GitHub issue form" (docs/submission-relay.md). Opened
// from the stats pages ("Submit game results"), the hub ("Create its
// stats page"), and the scorekeeper's Submit Results button; page-
// agnostic, so it builds its own DOM and appends to <body> on first use.
//
// The submitter pastes/attaches exported CSV(s) (or arrives with the
// current game's CSV prefilled from the scorekeeper), gets instant
// client-side validation via the same pure modules the pipeline runs
// server-side, and submits without leaving the page. A stored publishing
// key (util/submit-relay.js) rides along and — when valid — publishes
// with no human in the loop; otherwise the submission goes to normal
// maintainer review with a live preview link.

import { splitCsvBundle } from '../util/submission.js';
import { parseResultsCsv } from '../util/parse-results-csv.js';
import { submitResultsUrl } from '../util/submit-results.js';
import {
  TURNSTILE_SITE_KEY,
  getPublishingKey,
  loadPublishingKeys,
  keyHandoutUrl,
  submitResults,
} from '../util/submit-relay.js';
import { escapeHtml } from '../util/escape.js';
import { setStatus, wireModalDismiss } from './modal.js';

let modal = null;
let openOptions = {};
let turnstileWidgetId = null;

// ---------- client-side validation (same modules as the pipeline) ----------

function validateCsvText(text) {
  const chunks = splitCsvBundle(text);
  if (chunks.length === 0) {
    return { ok: false, count: 0, problems: [], summary: '' };
  }
  const problems = [];
  const labels = [];
  for (const [i, chunk] of chunks.entries()) {
    try {
      const parsed = parseResultsCsv(chunk);
      if (!parsed.teamA || !parsed.teamB) {
        problems.push(`Game ${i + 1}: missing "Team A"/"Team B" rows — is this an unmodified export?`);
      } else if (parsed.players.length === 0) {
        problems.push(`Game ${i + 1}: no player rows found.`);
      } else {
        labels.push(`${parsed.teamA} vs ${parsed.teamB}`);
      }
    } catch (e) {
      problems.push(`Game ${i + 1}: not a results CSV (${e.message}).`);
    }
  }
  return { ok: problems.length === 0, count: chunks.length, problems, summary: labels.join(' · ') };
}

// ---------- Turnstile (optional bot check) ----------

let turnstileScript = null;
function loadTurnstile() {
  if (!TURNSTILE_SITE_KEY) return Promise.resolve(null);
  if (!turnstileScript) {
    turnstileScript = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve(window.turnstile || null);
      s.onerror = () => resolve(null); // relay decides whether that's fatal
      document.head.appendChild(s);
    });
  }
  return turnstileScript;
}

async function mountTurnstile() {
  const container = modal.querySelector('#sf-turnstile');
  const turnstile = await loadTurnstile();
  if (!turnstile || !container || turnstileWidgetId !== null) return;
  turnstileWidgetId = turnstile.render(container, { sitekey: TURNSTILE_SITE_KEY });
}

function turnstileToken() {
  if (turnstileWidgetId === null || !window.turnstile) return '';
  return window.turnstile.getResponse(turnstileWidgetId) || '';
}

// ---------- modal ----------

function buildModal() {
  modal = document.createElement('div');
  modal.className = 'format-modal';
  modal.id = 'submission-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = `
    <div class="format-modal-card submission-card">
      <button class="format-modal-close" data-sf="close" title="Close" aria-label="Close">&times;</button>
      <h2 id="sf-title">Submit game results</h2>
      <div id="sf-form">
        <p class="format-modal-help" id="sf-help">
          Paste the CSV(s) you exported with the scorekeeper's <em>Export CSV</em> button —
          several games at once is fine. Re-submitting a game (same packet, same two teams)
          replaces the earlier version.
        </p>
        <label class="format-modal-label" for="sf-slug">Tournament slug</label>
        <input type="text" id="sf-slug" class="submission-input" autocomplete="off"
               list="sf-slug-known" placeholder="e.g. stanford-consensus-2026">
        <datalist id="sf-slug-known"></datalist>
        <div id="sf-new-tournament-fields" hidden>
          <label class="format-modal-label" for="sf-name">Tournament name <span class="submission-optional">(new tournaments only)</span></label>
          <input type="text" id="sf-name" class="submission-input" autocomplete="off" placeholder="Bay Area Open 2026">
          <label class="format-modal-label" for="sf-description">Description <span class="submission-optional">(shown on the hub card)</span></label>
          <input type="text" id="sf-description" class="submission-input" autocomplete="off">
        </div>
        <label class="format-modal-label" for="sf-csv">Results CSV</label>
        <textarea id="sf-csv" class="format-modal-textarea" rows="8" spellcheck="false"
                  placeholder="Packet,Pack 1.pdf&#10;Team A,…"></textarea>
        <div class="submission-file-row">
          <label class="btn submission-file-btn">Add .csv file(s)…<input type="file" id="sf-files" accept=".csv,text/csv" multiple hidden></label>
          <span id="sf-validation" class="submission-validation"></span>
        </div>
        <label class="format-modal-label" for="sf-key">Publishing key <span class="submission-optional">(optional — with a key, games publish instantly with no review; your tournament's organizer shares it as a link or a cs_… code)</span></label>
        <input type="password" id="sf-key" class="submission-input" autocomplete="off" placeholder="cs_…">
        <div id="sf-key-status" class="submission-validation"></div>
        <div id="sf-turnstile"></div>
        <div class="format-modal-actions">
          <button type="button" class="btn btn-start" data-sf="submit" id="sf-submit">Submit</button>
          <button type="button" class="btn" data-sf="close">Cancel</button>
          <span class="format-modal-status" id="sf-status"></span>
        </div>
        <p class="submission-fallback">Prefer GitHub? <a id="sf-github-link" target="_blank" rel="noopener">Use the issue form instead →</a></p>
      </div>
      <div id="sf-done" hidden></div>
    </div>`;
  document.body.appendChild(modal);
  wireModalDismiss(modal, closeSubmissionForm);

  modal.addEventListener('click', (e) => {
    const el = e.target.closest('[data-sf]');
    if (!el) return;
    if (el.dataset.sf === 'close') closeSubmissionForm();
    else if (el.dataset.sf === 'submit') submit();
    else if (el.dataset.sf === 'copy-key') copyKey(el);
  });
  modal.querySelector('#sf-files').addEventListener('change', addFiles);
  modal.querySelector('#sf-csv').addEventListener('input', showValidation);
  modal.querySelector('#sf-slug').addEventListener('input', () => {
    const slug = currentSlug();
    modal.querySelector('#sf-key').value = getPublishingKey(slug);
    modal.querySelector('#sf-github-link').href = submitResultsUrl(slug);
    refreshKeyStatus();
  });
  modal.querySelector('#sf-key').addEventListener('input', refreshKeyStatus);
}

// Make the trust state legible before submitting: a stored key that the
// field still matches means this device is set up for instant publishing.
function refreshKeyStatus() {
  const el = modal.querySelector('#sf-key-status');
  const typed = modal.querySelector('#sf-key').value.trim();
  const stored = getPublishingKey(currentSlug());
  if (typed && typed === stored) {
    el.textContent = '✓ Key on file for this tournament — this submission publishes instantly.';
    el.className = 'submission-validation success';
  } else if (typed) {
    el.textContent = 'Key will be checked when you submit.';
    el.className = 'submission-validation';
  } else {
    el.textContent = '';
  }
}

function currentSlug() {
  return modal.querySelector('#sf-slug').value.trim().toLowerCase();
}

async function addFiles(e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const texts = await Promise.all(files.map((f) => f.text()));
  const csvEl = modal.querySelector('#sf-csv');
  csvEl.value = [csvEl.value.trim(), ...texts.map((t) => t.trim())].filter(Boolean).join('\n');
  showValidation();
}

function showValidation() {
  const el = modal.querySelector('#sf-validation');
  const v = validateCsvText(modal.querySelector('#sf-csv').value);
  if (v.count === 0) {
    el.textContent = '';
  } else if (v.ok) {
    el.textContent = `✓ ${v.count} game${v.count === 1 ? '' : 's'} ready — ${v.summary}`;
    el.className = 'submission-validation success';
  } else {
    el.textContent = `⚠ ${v.problems[0]}`;
    el.className = 'submission-validation error';
  }
  return v;
}

async function submit() {
  const statusEl = modal.querySelector('#sf-status');
  const slug = currentSlug();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    setStatus(statusEl, 'Enter the tournament slug (lowercase letters, numbers, hyphens).', 'error');
    return;
  }
  const csv = modal.querySelector('#sf-csv').value;
  const v = validateCsvText(csv);
  if (v.count === 0) {
    setStatus(statusEl, 'Paste or attach at least one exported CSV first.', 'error');
    return;
  }
  if (!v.ok) {
    setStatus(statusEl, v.problems[0], 'error');
    return;
  }

  const button = modal.querySelector('#sf-submit');
  button.disabled = true;
  setStatus(statusEl, 'Submitting…');
  const result = await submitResults({
    slug,
    csv,
    name: modal.querySelector('#sf-name').value.trim(),
    description: modal.querySelector('#sf-description').value.trim(),
    key: modal.querySelector('#sf-key').value.trim(),
    turnstileToken: turnstileToken(),
  });
  button.disabled = false;

  if (!result.ok) {
    const details = (result.data.details || []).slice(0, 3).join(' ');
    setStatus(statusEl, `${result.data.error || 'Submission failed.'} ${details}`.trim(), 'error');
    if (window.turnstile && turnstileWidgetId !== null) window.turnstile.reset(turnstileWidgetId);
    return;
  }
  showSuccess(slug, result.data);
  if (openOptions.onDone) openOptions.onDone({ ...result.data, slug });
}

function showSuccess(slug, data) {
  const statsUrl = data.previewUrl
    ? new URL(`/tournaments/${slug}/`, data.previewUrl).toString()
    : `../tournaments/${slug}/`;
  const parts = [];
  if (data.verified) {
    parts.push(
      `<p class="format-modal-help">🎉 <strong>Published!</strong> Your games are being merged
       automatically — they'll show on the
       <a href="${escapeHtml(statsUrl)}" target="_blank" rel="noopener">tournament's stats page</a>
       within a couple of minutes.</p>`
    );
  } else {
    parts.push(
      `<p class="format-modal-help">✅ <strong>Submitted for review.</strong> A bot validates it
       within a minute or two, then a maintainer publishes it.</p>
       <p class="format-modal-help">📊 <a href="${escapeHtml(data.previewUrl || statsUrl)}"
       target="_blank" rel="noopener"><strong>Preview these stats now</strong></a> — no need to
       wait for the merge.</p>`
    );
  }
  if (data.newTournamentKey) {
    const handout = keyHandoutUrl(slug, data.newTournamentKey);
    parts.push(
      `<div class="submission-key-box">
         <p><strong>Your publishing key for <code>${escapeHtml(slug)}</code></strong> — shown only
         once, so save it now (it's also remembered on this device). Once the tournament is
         approved, submissions with this key publish instantly, with no review step.</p>
         <div class="submission-key-row">
           <input type="text" readonly class="submission-input" id="sf-issued-key"
                  value="${escapeHtml(data.newTournamentKey)}">
           <button type="button" class="btn" data-sf="copy-key">Copy</button>
         </div>
         <p>Easiest way to share it: send your room moderators
         <a href="${escapeHtml(handout)}" target="_blank" rel="noopener">this setup link</a> —
         opening it saves the key on their device, nothing to type.</p>
       </div>`
    );
  }
  if (data.issueUrl) {
    parts.push(
      `<p class="submission-fallback">Track it: <a href="${escapeHtml(data.issueUrl)}"
       target="_blank" rel="noopener">submission #${escapeHtml(String(data.issue))}</a></p>`
    );
  }
  parts.push(
    `<div class="format-modal-actions">
       <button type="button" class="btn btn-start" data-sf="close">Done</button>
     </div>`
  );
  modal.querySelector('#sf-form').hidden = true;
  const done = modal.querySelector('#sf-done');
  done.hidden = false;
  done.innerHTML = parts.join('\n');
}

async function copyKey(button) {
  const input = modal.querySelector('#sf-issued-key');
  try {
    await navigator.clipboard.writeText(input.value);
    button.textContent = 'Copied ✓';
  } catch {
    input.select();
    document.execCommand('copy');
    button.textContent = 'Copied ✓';
  }
}

// ---------- public API ----------

// opts: slug (prefill), lockSlug (stats pages — the slug is the page),
// csv (scorekeeper prefill), newTournament (hub's create flow — show the
// name/description fields), onDone(data).
export function openSubmissionForm(opts = {}) {
  openOptions = opts;
  if (!modal) buildModal();

  modal.querySelector('#sf-form').hidden = false;
  modal.querySelector('#sf-done').hidden = true;
  modal.querySelector('#sf-title').textContent =
    opts.newTournament ? 'Create a tournament stats page' : 'Submit game results';
  modal.querySelector('#sf-help').hidden = Boolean(opts.newTournament);
  modal.querySelector('#sf-new-tournament-fields').hidden = !opts.newTournament;

  // Devices with stored publishing keys already know their tournaments:
  // offer those slugs as suggestions, and when the slug is free-form
  // (scorekeeper flow) with exactly one known tournament, prefill it.
  const knownSlugs = Object.keys(loadPublishingKeys());
  modal.querySelector('#sf-slug-known').innerHTML =
    knownSlugs.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('');

  const slugEl = modal.querySelector('#sf-slug');
  slugEl.value = opts.slug || (!opts.lockSlug && !opts.newTournament && knownSlugs.length === 1
    ? knownSlugs[0] : '');
  slugEl.readOnly = Boolean(opts.lockSlug);
  modal.querySelector('#sf-csv').value = opts.csv || '';
  modal.querySelector('#sf-key').value = getPublishingKey(slugEl.value.trim());
  modal.querySelector('#sf-github-link').href = submitResultsUrl(opts.lockSlug ? opts.slug : '');
  setStatus(modal.querySelector('#sf-status'), '');
  showValidation();
  refreshKeyStatus();
  mountTurnstile();

  modal.classList.add('open');
  (opts.slug ? modal.querySelector('#sf-csv') : slugEl).focus();
}

export function closeSubmissionForm() {
  if (modal) modal.classList.remove('open');
}
