// Pure logic behind the pending-submission preview mode on the stats
// pages. A results submission lives on a `submission/issue-<N>` branch of
// the canonical repo until the maintainer merges its PR; preview mode
// (`?preview=<N>` on a stats page, or tournaments/preview.html for
// brand-new tournaments with no published page yet) lets the submitter
// see their stats immediately by overlaying the branch's CSVs onto the
// published games — entirely client-side, via the CORS-enabled GitHub
// REST API + raw.githubusercontent.com.
//
// Everything here is DOM- and fetch-free; ui/tournament-stats.js does the
// fetching and rendering, src/stats-main.js resolves the page context.

import { SUBMISSIONS_REPO } from './submit-results.js';
import { isValidTournamentSlug } from './submission.js';

// Must mirror the branch naming in .github/workflows/process-submission.yml.
export function submissionBranch(issueNumber) {
  return `submission/issue-${issueNumber}`;
}

// Resolves which tournament a stats page shows and whether it's in
// preview mode, from the page's <meta name="tournament-slug"> (per-slug
// pages) or its query string (tournaments/preview.html):
//   - slug        — tournament slug, '' if none/invalid
//   - baseDir     — path prefix from the page to the tournament folder
//                   ('' on per-slug pages, '<slug>/' on preview.html)
//   - manifestUrl — published manifest, relative to the page (null if no slug)
//   - issue       — submission issue number from ?preview=<N>, or null
// A query-string slug is untrusted input that lands in fetch URLs, so it
// only counts when it passes the same strict validator the submission
// pipeline uses.
export function resolvePreviewContext({ metaSlug = '', search = '' } = {}) {
  const params = new URLSearchParams(search);
  const previewRaw = (params.get('preview') || '').trim();
  const issue = /^\d+$/.test(previewRaw) ? Number(previewRaw) : null;

  let slug = metaSlug || '';
  let baseDir = '';
  if (!slug) {
    const querySlug = (params.get('slug') || '').trim();
    if (isValidTournamentSlug(querySlug)) {
      slug = querySlug;
      baseDir = `${querySlug}/`;
    }
  }
  return {
    slug,
    baseDir,
    manifestUrl: slug ? `${baseDir}results/manifest.json` : null,
    issue,
  };
}

// GitHub list-pulls filtered to the submission branch. state=all so a
// merged/closed submission can be reported as such instead of "missing".
export function pullsForIssueUrl(issueNumber) {
  const owner = SUBMISSIONS_REPO.split('/')[0];
  const params = new URLSearchParams({
    head: `${owner}:${submissionBranch(issueNumber)}`,
    state: 'all',
    per_page: '10',
  });
  return `https://api.github.com/repos/${SUBMISSIONS_REPO}/pulls?${params}`;
}

// The workflow force-updates one branch per issue, so there is normally
// exactly one PR — but a maintainer may have closed one and a rerun opened
// another. Prefer the open PR; otherwise report the newest one's fate.
export function classifyPull(pulls) {
  if (!Array.isArray(pulls) || pulls.length === 0) return { status: 'missing', pull: null };
  const open = pulls.find((p) => p && p.state === 'open');
  const pull = open || pulls[0];
  const status = pull.state === 'open' ? 'open' : (pull.merged_at ? 'merged' : 'closed');
  return { status, pull };
}

export function pullFilesUrl(prNumber, page = 1) {
  return `https://api.github.com/repos/${SUBMISSIONS_REPO}/pulls/${prNumber}/files?per_page=100&page=${page}`;
}

// From a list-PR-files response, the games this preview should overlay:
// CSVs directly inside this tournament's results folder, still present on
// the branch. New-tournament PRs also touch roster-presets.js and the
// generated index.html — the path filter drops those.
export function previewCsvFiles(files, slug) {
  const prefix = `tournaments/${slug}/results/`;
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.filename === 'string'
      && f.status !== 'removed'
      && f.filename.startsWith(prefix)
      && /\.csv$/i.test(f.filename)
      && !f.filename.slice(prefix.length).includes('/'))
    .map((f) => ({ path: f.filename, filename: f.filename.slice(prefix.length) }));
}

// Raw file on the PR's head commit. Pinned to the SHA (not the branch
// name) so raw.githubusercontent.com's ~5-minute CDN cache can never
// serve a stale mix after the submitter edits their issue.
export function rawFileUrl(sha, filePath) {
  const encoded = String(filePath).split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${SUBMISSIONS_REPO}/${sha}/${encoded}`;
}

// Banner copy for every preview outcome. Plain text — the caller assigns
// it via textContent, so nothing here needs escaping.
export function previewBannerText({ status, issue, loaded = 0, replaced = 0, failed = 0 }) {
  const games = (n) => `${n} game${n === 1 ? '' : 's'}`;
  switch (status) {
    case 'open': {
      if (loaded === 0 && failed === 0) {
        return `Pending submission #${issue} has no games for this tournament — showing published stats only.`;
      }
      let text = `Previewing pending submission #${issue}: ${games(loaded)} not yet published`;
      if (replaced) text += ` (${replaced} replacing a published game)`;
      if (failed) text += ` — ${games(failed)} failed to load`;
      return text + '. Nothing shown here is official until a maintainer merges the submission.';
    }
    case 'merged':
      return `Submission #${issue} has been merged — these are the published stats.`;
    case 'closed':
      return `Submission #${issue} was closed without being merged — showing published stats only.`;
    case 'missing':
      return `No submission found for #${issue} — it may still be processing. Showing published stats only.`;
    default:
      return `Couldn't load pending submission #${issue} (GitHub API unavailable or rate-limited) — showing published stats only.`;
  }
}
