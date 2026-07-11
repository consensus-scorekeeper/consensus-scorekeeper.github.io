// Pending-submission preview logic (src/util/submission-preview.js):
// page-context resolution, GitHub API URL builders, PR classification,
// changed-file filtering, and banner copy.

import { describe, it, expect } from 'vitest';
import { SUBMISSIONS_REPO } from '../src/util/submit-results.js';
import {
  submissionBranch,
  resolvePreviewContext,
  pullsForIssueUrl,
  classifyPull,
  pullFilesUrl,
  previewCsvFiles,
  rawFileUrl,
  previewBannerText,
} from '../src/util/submission-preview.js';

describe('resolvePreviewContext', () => {
  it('uses the meta slug with a page-relative manifest on per-tournament pages', () => {
    const ctx = resolvePreviewContext({ metaSlug: 'stanford-consensus-2026', search: '' });
    expect(ctx).toEqual({
      slug: 'stanford-consensus-2026',
      baseDir: '',
      manifestUrl: 'results/manifest.json',
      issue: null,
    });
  });

  it('meta slug wins over a query slug', () => {
    const ctx = resolvePreviewContext({ metaSlug: 'real-slug', search: '?slug=other-slug' });
    expect(ctx.slug).toBe('real-slug');
    expect(ctx.baseDir).toBe('');
  });

  it('falls back to a validated query slug with a slug-prefixed base dir (preview page)', () => {
    const ctx = resolvePreviewContext({ metaSlug: '', search: '?slug=bay-area-open-2026&preview=12' });
    expect(ctx).toEqual({
      slug: 'bay-area-open-2026',
      baseDir: 'bay-area-open-2026/',
      manifestUrl: 'bay-area-open-2026/results/manifest.json',
      issue: 12,
    });
  });

  it('rejects a query slug that fails the strict validator (path-traversal guard)', () => {
    for (const bad of ['../../etc', 'Has Spaces', 'UPPER', 'a/b', '']) {
      const ctx = resolvePreviewContext({ metaSlug: '', search: `?slug=${encodeURIComponent(bad)}` });
      expect(ctx.slug).toBe('');
      expect(ctx.manifestUrl).toBeNull();
    }
  });

  it('parses ?preview= only as a positive integer', () => {
    expect(resolvePreviewContext({ metaSlug: 's', search: '?preview=42' }).issue).toBe(42);
    for (const bad of ['', 'abc', '1.5', '-3', '1e3']) {
      expect(resolvePreviewContext({ metaSlug: 's', search: `?preview=${bad}` }).issue).toBeNull();
    }
    expect(resolvePreviewContext({ metaSlug: 's', search: '' }).issue).toBeNull();
  });
});

describe('GitHub API URL builders', () => {
  it('submissionBranch mirrors the workflow naming', () => {
    expect(submissionBranch(17)).toBe('submission/issue-17');
  });

  it('pullsForIssueUrl targets the canonical repo, filtered to the branch, state=all', () => {
    const url = new URL(pullsForIssueUrl(17));
    expect(url.origin + url.pathname).toBe(`https://api.github.com/repos/${SUBMISSIONS_REPO}/pulls`);
    expect(url.searchParams.get('head')).toBe(`${SUBMISSIONS_REPO.split('/')[0]}:submission/issue-17`);
    expect(url.searchParams.get('state')).toBe('all');
  });

  it('pullFilesUrl paginates', () => {
    expect(pullFilesUrl(9)).toContain(`/repos/${SUBMISSIONS_REPO}/pulls/9/files?per_page=100&page=1`);
    expect(pullFilesUrl(9, 3)).toContain('page=3');
  });

  it('rawFileUrl pins to the SHA and percent-encodes each path segment', () => {
    const url = rawFileUrl('abc123', 'tournaments/my-slug/results/Pack 1 - A vs B.csv');
    expect(url).toBe(
      `https://raw.githubusercontent.com/${SUBMISSIONS_REPO}/abc123/tournaments/my-slug/results/Pack%201%20-%20A%20vs%20B.csv`
    );
  });
});

describe('classifyPull', () => {
  it('reports missing when there is no PR yet', () => {
    expect(classifyPull([])).toEqual({ status: 'missing', pull: null });
    expect(classifyPull(undefined)).toEqual({ status: 'missing', pull: null });
  });

  it('prefers the open PR over closed ones', () => {
    const open = { number: 5, state: 'open', merged_at: null };
    const closed = { number: 3, state: 'closed', merged_at: null };
    expect(classifyPull([closed, open])).toEqual({ status: 'open', pull: open });
  });

  it('distinguishes merged from closed-unmerged', () => {
    const merged = { number: 5, state: 'closed', merged_at: '2026-07-01T00:00:00Z' };
    const closed = { number: 5, state: 'closed', merged_at: null };
    expect(classifyPull([merged]).status).toBe('merged');
    expect(classifyPull([closed]).status).toBe('closed');
  });
});

describe('previewCsvFiles', () => {
  const files = [
    { filename: 'tournaments/my-slug/results/Pack 1 - A vs B.csv', status: 'added' },
    { filename: 'tournaments/my-slug/results/Pack 2 - C vs D.csv', status: 'modified' },
    { filename: 'tournaments/my-slug/results/old.csv', status: 'removed' },
    { filename: 'tournaments/my-slug/results/manifest.json', status: 'modified' },
    { filename: 'tournaments/my-slug/results/nested/deep.csv', status: 'added' },
    { filename: 'tournaments/other-slug/results/Pack 1 - X vs Y.csv', status: 'added' },
    { filename: 'src/ui/roster-presets.js', status: 'modified' },
    { filename: 'tournaments/my-slug/index.html', status: 'added' },
  ];

  it('keeps only live CSVs directly inside this slug\'s results folder', () => {
    expect(previewCsvFiles(files, 'my-slug')).toEqual([
      { path: 'tournaments/my-slug/results/Pack 1 - A vs B.csv', filename: 'Pack 1 - A vs B.csv' },
      { path: 'tournaments/my-slug/results/Pack 2 - C vs D.csv', filename: 'Pack 2 - C vs D.csv' },
    ]);
  });

  it('tolerates junk input', () => {
    expect(previewCsvFiles(null, 'my-slug')).toEqual([]);
    expect(previewCsvFiles([null, {}, { filename: 42 }], 'my-slug')).toEqual([]);
  });
});

describe('previewBannerText', () => {
  it('describes an open submission with counts', () => {
    const text = previewBannerText({ status: 'open', issue: 8, loaded: 3, replaced: 1 });
    expect(text).toContain('#8');
    expect(text).toContain('3 games not yet published');
    expect(text).toContain('1 replacing a published game');
    expect(text).toContain('until a maintainer merges');
  });

  it('reports load failures', () => {
    expect(previewBannerText({ status: 'open', issue: 8, loaded: 2, failed: 1 }))
      .toContain('1 game failed to load');
  });

  it('handles an open submission with nothing for this tournament', () => {
    expect(previewBannerText({ status: 'open', issue: 8 }))
      .toContain('no games for this tournament');
  });

  it('covers every terminal state', () => {
    expect(previewBannerText({ status: 'merged', issue: 8 })).toContain('has been merged');
    expect(previewBannerText({ status: 'closed', issue: 8 })).toContain('closed without being merged');
    expect(previewBannerText({ status: 'missing', issue: 8 })).toContain('No submission found');
    expect(previewBannerText({ status: 'error', issue: 8 })).toContain('showing published stats only');
  });
});
