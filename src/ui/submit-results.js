// "Submit Results" button: opens the GitHub submit-results issue form
// prefilled with the current game's CSV, so a scorer can publish to the
// public stats pages without leaving the app.
//
// Submissions go to the repo that hosts the site, but a mirror or local
// dev copy must still target the canonical repo, so this URL is a
// constant rather than derived from location.href.
//
// GitHub prefills issue-form fields from query params keyed by field id
// (`tournament`, `csv` — see .github/ISSUE_TEMPLATE/submit-results.yml).
// Long URLs get rejected by GitHub with a 414, so past a conservative
// length cap we fall back to copying the CSV to the clipboard and opening
// the blank form for the user to paste into.

import { getTournamentBySlug } from './roster-presets.js';

const SUBMISSIONS_REPO = 'consensus-scorekeeper/consensus-scorekeeper.github.io';
const MAX_PREFILL_URL_LENGTH = 6500;

export function openSubmitResults({ csv, tournamentSlug }) {
  const base = `https://github.com/${SUBMISSIONS_REPO}/issues/new`;
  const params = new URLSearchParams({ template: 'submit-results.yml' });
  // Only prefill built-in tournaments — custom (localStorage) tournaments
  // have no public stats page to submit to.
  if (tournamentSlug && getTournamentBySlug(tournamentSlug)) {
    params.set('tournament', tournamentSlug);
  }
  params.set('csv', csv);

  let url = `${base}?${params}`;
  if (url.length > MAX_PREFILL_URL_LENGTH) {
    params.delete('csv');
    url = `${base}?${params}`;
    copyCsvThenExplain(csv);
  }
  // window.open must run synchronously inside the click gesture, so the
  // clipboard fallback above never awaits before this line.
  window.open(url, '_blank', 'noopener');
}

function copyCsvThenExplain(csv) {
  const explain = (copied) => alert(copied
    ? 'This game is too large to prefill, so the CSV was copied to your clipboard — paste it into the "Results CSV" box on the GitHub form that just opened.'
    : 'This game is too large to prefill and clipboard access was blocked — use "Export CSV" and paste (or attach) the file on the GitHub form that just opened.');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(csv).then(() => explain(true), () => explain(false));
  } else {
    explain(false);
  }
}
