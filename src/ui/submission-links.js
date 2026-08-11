// DOM builders for the results-submission intake links. With the
// submit-relay Worker configured (util/submit-relay.js), the links open
// the in-page submission modal (ui/submission-form.js) — no GitHub
// account needed; the href still points at the GitHub issue form, so
// middle-click/copy-link and the relay-disabled fallback behave exactly
// as before. Submitting games under a fresh slug is also how a new
// tournament's stats page gets created, so "create a tournament" is the
// same modal in its create flavor.
//
// submitResultsLink goes on every per-tournament stats page (stats-main.js);
// createTournamentLink on the stats hub only (tournaments-main.js). Must stay
// free of scorekeeper-only DOM assumptions.

import { submitResultsUrl } from '../util/submit-results.js';
import { relayEnabled } from '../util/submit-relay.js';
import { openSubmissionForm } from './submission-form.js';

function linkParagraph({ prefix, href, text, title, formOptions }) {
  const p = document.createElement('p');
  p.className = 'ts-intro';
  if (prefix) p.append(prefix + ' ');
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = text;
  link.title = title;
  if (relayEnabled()) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openSubmissionForm(formOptions);
    });
  }
  p.appendChild(link);
  return p;
}

export function submitResultsLink(slug) {
  return linkParagraph({
    href: submitResultsUrl(slug),
    text: 'Submit game results →',
    title: 'Publish a scored game to this page — paste or attach the CSV(s) you exported from the scorekeeper.',
    formOptions: { slug, lockSlug: true },
  });
}

export function createTournamentLink() {
  return linkParagraph({
    prefix: 'Running your own tournament?',
    href: submitResultsUrl(''),
    text: 'Create its stats page →',
    title: 'Pick a fresh slug and paste or attach your games’ CSVs; the tournament’s stats page is created automatically.',
    formOptions: { newTournament: true },
  });
}
