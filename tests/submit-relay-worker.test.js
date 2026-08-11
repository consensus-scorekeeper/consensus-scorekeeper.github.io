// Integration tests for the submit-relay Worker (workers/submit-relay/
// worker.js) with mocked KV + GitHub + site fetches: the publishing-key
// state machine (fresh slug → pending → active), the verified stamp, and
// the abuse gates. The Worker is plain ESM, so vitest imports it directly
// — same code wrangler deploys. See docs/submission-relay.md.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import worker from '../workers/submit-relay/worker.js';
import { parseVerifiedSlug, parseFormSections, stripCodeFence } from '../src/util/relay-issue.js';

const CSV = [
  'Packet,Pack 1.pdf',
  'Team A,Alpha',
  'Team B,Beta',
  '',
  'Team,Score',
  'Alpha,100',
  'Beta,80',
  '',
  'Player,Team,Points',
  'Alice,Alpha,60',
  'Bob,Beta,80',
].join('\n');

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.has(key) ? store.get(key) : null;
      return v !== null && type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
  };
}

let env;
let createdIssues;     // captured GitHub issue payloads
let publishedSlugs;    // slugs whose manifest.json "exists" on the site
let issueCounter;

beforeEach(() => {
  createdIssues = [];
  publishedSlugs = new Set(['stanford-consensus-2026']);
  issueCounter = 100;
  env = {
    KEYS: makeKv(),
    GITHUB_TOKEN: 'test-pat',
    ADMIN_SECRET: 'shhh-admin',
    REPO: 'org/repo',
    SITE_BASE: 'https://site.example',
  };
  vi.stubGlobal('fetch', async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.github.com/repos/org/repo/issues')) {
      const payload = JSON.parse(opts.body);
      const number = ++issueCounter;
      createdIssues.push({ number, ...payload });
      return { ok: true, status: 201, json: async () => ({ number, html_url: `https://github.com/org/repo/issues/${number}` }) };
    }
    const m = /^https:\/\/site\.example\/tournaments\/([^/]+)\/results\/manifest\.json$/.exec(u);
    if (m) return { ok: publishedSlugs.has(m[1]), status: publishedSlugs.has(m[1]) ? 200 : 404 };
    throw new Error(`unexpected fetch: ${u}`);
  });
});

afterEach(() => vi.unstubAllGlobals());

function request(path, payload, headers = {}) {
  const map = { 'content-type': 'application/json', ...Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  ) };
  return {
    method: 'POST',
    url: `https://relay.test${path}`,
    headers: { get: (name) => map[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(payload),
  };
}

async function call(path, payload, headers) {
  const res = await worker.fetch(request(path, payload, headers), env);
  return { status: res.status, data: JSON.parse(await res.text()) };
}

describe('POST /submit', () => {
  it('mints a pending key for a fresh slug and files an unstamped issue', async () => {
    const { status, data } = await call('/submit', { slug: 'new-open-2026', csv: CSV });
    expect(status).toBe(200);
    expect(data.newTournamentKey).toMatch(/^cs_[0-9a-f]{40}$/);
    expect(data.verified).toBe(false);
    expect(data.previewUrl).toBe(`https://site.example/tournaments/preview.html?slug=new-open-2026&preview=${data.issue}`);

    const kv = await env.KEYS.get('slug:new-open-2026', 'json');
    expect(kv.status).toBe('pending');

    expect(createdIssues).toHaveLength(1);
    expect(createdIssues[0].labels).toEqual(['results-submission']);
    expect(parseVerifiedSlug(createdIssues[0].body)).toBe(null);
    expect(stripCodeFence(parseFormSections(createdIssues[0].body)['Results CSV'])).toBe(CSV);
  });

  it('does not verify with a pending key; verifies once activated', async () => {
    const first = await call('/submit', { slug: 'new-open-2026', csv: CSV });
    const key = first.data.newTournamentKey;

    const pending = await call('/submit', { slug: 'new-open-2026', csv: CSV, key });
    expect(pending.data.verified).toBe(false);
    expect(pending.data.newTournamentKey).toBeUndefined(); // never minted twice

    await call('/admin/activate', { slug: 'new-open-2026' }, { Authorization: 'Bearer shhh-admin' });

    const active = await call('/submit', { slug: 'new-open-2026', csv: CSV, key });
    expect(active.data.verified).toBe(true);
    const body = createdIssues.at(-1).body;
    expect(parseVerifiedSlug(body)).toBe('new-open-2026');
  });

  it('rejects a wrong key (falls back to unverified, no key minted)', async () => {
    await call('/admin/rotate', { slug: 'stanford-consensus-2026' }, { Authorization: 'Bearer shhh-admin' });
    const { data } = await call('/submit', {
      slug: 'stanford-consensus-2026', csv: CSV, key: 'cs_' + 'f'.repeat(40),
    });
    expect(data.verified).toBe(false);
    expect(data.newTournamentKey).toBeUndefined();
  });

  it('never mints a key for an already-published tournament', async () => {
    const { data } = await call('/submit', { slug: 'stanford-consensus-2026', csv: CSV });
    expect(data.newTournamentKey).toBeUndefined();
    expect(await env.KEYS.get('slug:stanford-consensus-2026')).toBe(null);
  });

  it('rejects garbage CSV without filing an issue', async () => {
    const { status } = await call('/submit', { slug: 'new-open-2026', csv: 'not,a,results\ncsv' });
    expect(status).toBe(422);
    expect(createdIssues).toHaveLength(0);
  });

  it('rejects invalid slugs', async () => {
    const { status } = await call('/submit', { slug: '../evil', csv: CSV });
    expect(status).toBe(422);
  });
});

describe('POST /remove-game', () => {
  async function activeKeyFor(slug) {
    const { data } = await call('/admin/rotate', { slug }, { Authorization: 'Bearer shhh-admin' });
    return data.key;
  }

  it('requires an active matching key', async () => {
    const noKey = await call('/remove-game', { slug: 'stanford-consensus-2026', filename: 'a.csv' });
    expect(noKey.status).toBe(403);

    const key = await activeKeyFor('stanford-consensus-2026');
    const ok = await call('/remove-game', { slug: 'stanford-consensus-2026', filename: 'Pack 1 - Alpha vs Beta.csv', key });
    expect(ok.status).toBe(200);
    const issue = createdIssues.at(-1);
    expect(issue.labels).toEqual(['game-removal']);
    expect(parseVerifiedSlug(issue.body)).toBe('stanford-consensus-2026');
    expect(parseFormSections(issue.body)['Filename']).toBe('Pack 1 - Alpha vs Beta.csv');
  });

  it('rejects path-shaped filenames outright', async () => {
    const key = await activeKeyFor('stanford-consensus-2026');
    for (const filename of ['../../evil.csv', 'a/b.csv', 'x.txt']) {
      const { status } = await call('/remove-game', { slug: 'stanford-consensus-2026', filename, key });
      expect(status, filename).toBe(422);
    }
  });
});

describe('admin endpoints', () => {
  it('reject a wrong or missing secret', async () => {
    for (const headers of [{}, { Authorization: 'Bearer wrong' }]) {
      const { status } = await call('/admin/rotate', { slug: 'x-1' }, headers);
      expect(status).toBe(403);
    }
  });

  it('rotate mints a working key; delete-key revokes it', async () => {
    const { data } = await call('/admin/rotate', { slug: 'stanford-consensus-2026' }, { Authorization: 'Bearer shhh-admin' });
    expect(data.key).toMatch(/^cs_[0-9a-f]{40}$/);

    const verified = await call('/submit', { slug: 'stanford-consensus-2026', csv: CSV, key: data.key });
    expect(verified.data.verified).toBe(true);

    await call('/admin/delete-key', { slug: 'stanford-consensus-2026' }, { Authorization: 'Bearer shhh-admin' });
    const after = await call('/submit', { slug: 'stanford-consensus-2026', csv: CSV, key: data.key });
    expect(after.data.verified).toBe(false);
  });
});
