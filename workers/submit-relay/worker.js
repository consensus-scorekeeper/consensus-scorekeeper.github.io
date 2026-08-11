// Consensus submit-relay — a Cloudflare Worker that lets people publish
// scored games (and tournament-key-verified corrections) WITHOUT a GitHub
// account. It files the "Submit game results" issue on the submitter's
// behalf; everything downstream is the existing results-submission
// pipeline, unchanged. Trust model + full design: docs/submission-relay.md.
//
// Endpoints (all JSON POST):
//   /submit       {slug, csv, name?, description?, notes?, key?, turnstileToken?}
//   /remove-game  {slug, filename, key}
//   /admin/activate | /admin/delete-key | /admin/rotate   {slug}
//                 (Authorization: Bearer <ADMIN_SECRET>)
//
// Bindings (see wrangler.toml + README.md):
//   KEYS                 KV namespace — publishing-key hashes + rate counters
//   GITHUB_APP_KEY       secret — GitHub App private key (PKCS#8 PEM)  } either
//   GITHUB_TOKEN         secret — fine-grained PAT (issues-only)       } one
//   ADMIN_SECRET         secret — gates /admin/*
//   TURNSTILE_SECRET     secret, optional — enables Turnstile verification
//   GITHUB_APP_ID, GITHUB_INSTALLATION_ID, REPO, SITE_BASE   vars
//
// Deployed with `npx wrangler deploy` from this folder — wrangler bundles
// the ../../src/util imports, so the CSV validation and the issue-body
// format are the site's own modules and can't drift from the pipeline.

import {
  buildSubmissionIssueBody,
  buildRemovalIssueBody,
  generatePublishingKey,
  hashPublishingKey,
  RESULTS_LABEL,
  REMOVAL_LABEL,
} from '../../src/util/relay-issue.js';
import { isValidTournamentSlug, splitCsvBundle } from '../../src/util/submission.js';
import { parseResultsCsv } from '../../src/util/parse-results-csv.js';

// Page origins allowed to call the relay from a browser. Requests with no
// Origin header (curl, workflows) pass — keys/admin secret gate those.
const ALLOWED_ORIGINS = [
  'https://consensus-scorekeeper.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

// Caps. The free Workers plan (100k req/day) is the hard backstop; these
// keep one bad actor from burning it and from churning a stats page.
const MAX_BODY_BYTES = 300_000;      // several games is ~15 KB; this is generous
const MAX_PER_IP_PER_DAY = 50;
const MAX_PER_SLUG_PER_DAY = 300;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(status, obj) {
  return new Response(JSON.stringify(obj) + '\n', {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

// ---------- GitHub auth ----------
// Prefer the GitHub App (no expiry, clean bot identity — the pipeline's
// author wall expects its [bot] login). GITHUB_TOKEN (a fine-grained
// issues-only PAT) is the quick-start alternative.

let cachedInstallToken = null; // { token, expiresAt } — per-isolate cache

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function appJwt(env) {
  const pem = env.GITHUB_APP_KEY.replace(/-----[A-Z ]+-----|\s/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const header = base64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(enc.encode(JSON.stringify({
    iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID,
  })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(sig)}`;
}

async function githubToken(env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (cachedInstallToken && Date.now() < cachedInstallToken.expiresAt) {
    return cachedInstallToken.token;
  }
  const res = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await appJwt(env)}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'consensus-submit-relay',
      },
    }
  );
  if (!res.ok) throw new Error(`installation token: ${res.status} ${await res.text()}`);
  const data = await res.json();
  // GitHub App tokens last an hour; refresh five minutes early.
  cachedInstallToken = { token: data.token, expiresAt: Date.now() + 55 * 60 * 1000 };
  return data.token;
}

async function createIssue(env, { title, body, label }) {
  const res = await fetch(`https://api.github.com/repos/${env.REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await githubToken(env)}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'consensus-submit-relay',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels: [label] }),
  });
  if (!res.ok) throw new Error(`create issue: ${res.status} ${await res.text()}`);
  const issue = await res.json();
  return { number: issue.number, url: issue.html_url };
}

// ---------- abuse gates ----------

async function turnstileOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true; // not configured — skip
  if (!token) return false;
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

// KV counters are racy under concurrency — fine: this is a blunt cap, not
// billing. Keys expire on their own.
async function overRateLimit(env, request, slug) {
  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  for (const [key, cap] of [
    [`rl:ip:${ip}:${day}`, MAX_PER_IP_PER_DAY],
    [`rl:slug:${slug}:${day}`, MAX_PER_SLUG_PER_DAY],
  ]) {
    const count = parseInt((await env.KEYS.get(key)) || '0', 10) + 1;
    if (count > cap) return true;
    await env.KEYS.put(key, String(count), { expirationTtl: 2 * 86400 });
  }
  return false;
}

// ---------- publishing keys ----------

const kvKey = (slug) => `slug:${slug}`;

async function keyEntry(env, slug) {
  return env.KEYS.get(kvKey(slug), 'json');
}

async function keyMatches(entry, key) {
  return Boolean(entry && key && (await hashPublishingKey(key)) === entry.hash);
}

// Does the slug already have a published stats page? Decides whether a
// keyless submission for an un-keyed slug is a NEW tournament (issue a
// key) or a pre-relay one (no key until the maintainer mints one).
async function tournamentPublished(env, slug) {
  const res = await fetch(
    `${env.SITE_BASE}/tournaments/${slug}/results/manifest.json`,
    { method: 'HEAD', cf: { cacheTtl: 300 } }
  );
  if (res.status === 404) return false;
  return true; // 200 — or errors, in which case assume existing (never mint a key on doubt)
}

// ---------- request validation ----------

function validateGames(csv) {
  const chunks = splitCsvBundle(csv);
  if (chunks.length === 0) return { errors: ['No results CSV found in the submission.'] };
  const errors = [];
  for (const [i, chunk] of chunks.entries()) {
    try {
      const parsed = parseResultsCsv(chunk);
      if (!parsed.teamA || !parsed.teamB) {
        errors.push(`Game ${i + 1}: missing "Team A" / "Team B" metadata rows.`);
      } else if (parsed.players.length === 0) {
        errors.push(`Game ${i + 1}: no player rows found.`);
      }
    } catch (e) {
      errors.push(`Game ${i + 1}: not a valid results CSV (${e.message}).`);
    }
  }
  return { errors };
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: json(413, { error: 'Submission too large.' }) };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: json(400, { error: 'Body must be JSON.' }) };
  }
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// ---------- endpoints ----------

async function handleSubmit(env, request) {
  const { body, error } = await readBody(request);
  if (error) return error;

  const slug = str(body.slug, 60).trim();
  if (!isValidTournamentSlug(slug)) {
    return json(422, { error: 'Invalid tournament slug — lowercase letters, numbers, hyphens.' });
  }
  const csv = str(body.csv, MAX_BODY_BYTES);
  const { errors } = validateGames(csv);
  if (errors.length > 0) return json(422, { error: 'Invalid CSV.', details: errors });

  const ip = request.headers.get('CF-Connecting-IP');
  if (!(await turnstileOk(env, body.turnstileToken, ip))) {
    return json(403, { error: 'Verification challenge failed — reload and try again.' });
  }
  if (await overRateLimit(env, request, slug)) {
    return json(429, { error: 'Rate limit exceeded — try again tomorrow or submit via GitHub.' });
  }

  // Key check → verified stamp; fresh slug → mint a pending key.
  const entry = await keyEntry(env, slug);
  let verified = false;
  let newTournamentKey = null;
  if (entry && entry.status === 'active' && (await keyMatches(entry, str(body.key, 100)))) {
    verified = true;
  } else if (!entry && !(await tournamentPublished(env, slug))) {
    newTournamentKey = generatePublishingKey();
    await env.KEYS.put(kvKey(slug), JSON.stringify({
      hash: await hashPublishingKey(newTournamentKey),
      status: 'pending', // activated by finalize-submission.yml when the creation PR merges
      created: new Date().toISOString(),
    }));
  }

  const issue = await createIssue(env, {
    title: `Results submission: ${slug}`,
    body: buildSubmissionIssueBody({
      slug,
      name: str(body.name, 100),
      description: str(body.description, 300),
      csv,
      notes: str(body.notes, 2000),
      verifiedSlug: verified ? slug : null,
    }),
    label: RESULTS_LABEL,
  });

  return json(200, {
    issue: issue.number,
    issueUrl: issue.url,
    previewUrl: `${env.SITE_BASE}/tournaments/preview.html?slug=${slug}&preview=${issue.number}`,
    verified,
    ...(newTournamentKey ? { newTournamentKey } : {}),
  });
}

async function handleRemoveGame(env, request) {
  const { body, error } = await readBody(request);
  if (error) return error;

  const slug = str(body.slug, 60).trim();
  const filename = str(body.filename, 200).trim();
  if (!isValidTournamentSlug(slug)) return json(422, { error: 'Invalid tournament slug.' });
  // Basename only — the workflow re-checks, but never let a path leave here.
  if (!/^[^/\\]+\.csv$/i.test(filename) || filename.includes('..')) {
    return json(422, { error: 'Invalid filename.' });
  }

  // Removal has no manual-review fallback: active key or nothing.
  const entry = await keyEntry(env, slug);
  if (!entry || entry.status !== 'active' || !(await keyMatches(entry, str(body.key, 100)))) {
    return json(403, { error: 'A valid publishing key for this tournament is required to remove games.' });
  }
  if (await overRateLimit(env, request, slug)) {
    return json(429, { error: 'Rate limit exceeded.' });
  }

  const issue = await createIssue(env, {
    title: `Remove game: ${slug}`,
    body: buildRemovalIssueBody({ slug, filename, verifiedSlug: slug }),
    label: REMOVAL_LABEL,
  });
  return json(200, { issue: issue.number, issueUrl: issue.url });
}

async function handleAdmin(env, request, action) {
  const auth = request.headers.get('Authorization') || '';
  // Compare hashes rather than strings so the check is constant-time.
  const given = await hashPublishingKey(auth.replace(/^Bearer\s+/i, ''));
  const expected = await hashPublishingKey(env.ADMIN_SECRET || '');
  if (!env.ADMIN_SECRET || given !== expected) return json(403, { error: 'Forbidden.' });

  const { body, error } = await readBody(request);
  if (error) return error;
  const slug = str(body.slug, 60).trim();
  if (!isValidTournamentSlug(slug)) return json(422, { error: 'Invalid tournament slug.' });

  if (action === 'activate') {
    const entry = await keyEntry(env, slug);
    if (!entry) return json(404, { error: 'No key recorded for this slug.' });
    await env.KEYS.put(kvKey(slug), JSON.stringify({ ...entry, status: 'active' }));
    return json(200, { ok: true, slug, status: 'active' });
  }
  if (action === 'delete-key') {
    await env.KEYS.delete(kvKey(slug));
    return json(200, { ok: true, slug, deleted: true });
  }
  if (action === 'rotate') {
    const key = generatePublishingKey();
    await env.KEYS.put(kvKey(slug), JSON.stringify({
      hash: await hashPublishingKey(key),
      status: 'active',
      created: new Date().toISOString(),
    }));
    return json(200, { ok: true, slug, key });
  }
  return json(404, { error: 'Unknown admin action.' });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
    if (!originAllowed(request)) return json(403, { error: 'Origin not allowed.' });

    const path = new URL(request.url).pathname;
    try {
      if (path === '/submit') return await handleSubmit(env, request);
      if (path === '/remove-game') return await handleRemoveGame(env, request);
      const admin = /^\/admin\/([a-z-]+)$/.exec(path);
      if (admin) return await handleAdmin(env, request, admin[1]);
      return json(404, { error: 'Not found.' });
    } catch (e) {
      // Never leak stack traces / token fragments to callers.
      console.error(e);
      return json(502, { error: 'Relay error — try again, or submit via the GitHub form.' });
    }
  },
};
