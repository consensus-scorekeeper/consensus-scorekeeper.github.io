// Consensus pack-proxy — a Cloudflare Worker that relays PDF/ZIP packs from
// consensustrivia.com with permissive CORS so the scorekeeper's in-browser
// "browse packs" flow can fetch them. consensustrivia.com serves the packs
// with NO Access-Control-Allow-Origin header, so a static site (GitHub Pages)
// can't fetch them directly — this Worker is the relay that fixes that.
//
// Deploy + security notes: see README.md in this folder.
//
// Usage:  GET https://<worker>/?u=<url-encoded consensustrivia.com pack URL>
//
// The repo is public, so this URL is discoverable. The protections below keep
// it from being useful as a general-purpose open proxy or a way to run up cost:
//   1. Upstream host allowlist — it will ONLY fetch consensustrivia.com. It can
//      never be pointed at an arbitrary origin.
//   2. Path allowlist — only *.pdf / *.zip under /packs/ paths.
//   3. Origin/Referer allowlist — soft gate against casual embedding elsewhere.
//   4. Cloudflare free plan hard-caps at 100k requests/day and simply starts
//      erroring after that; it never bills you (do NOT enable Workers Paid).
//   5. Edge caching (cf.cacheEverything) so repeat downloads of the same pack
//      barely touch consensustrivia.com and stay fast.

const ALLOWED_HOSTS = new Set(['www.consensustrivia.com', 'consensustrivia.com']);

// Soft allowlist of page origins permitted to use the relay. Add a mirror's
// origin here if you host the site elsewhere. Leave the array empty to disable
// the Origin/Referer check entirely (host + path allowlists still apply).
const ALLOWED_ORIGINS = [
  'https://consensus-scorekeeper.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function deny(status, message) {
  return new Response(message + '\n', { status, headers: CORS_HEADERS });
}

function originAllowed(request) {
  if (ALLOWED_ORIGINS.length === 0) return true;
  const origin = request.headers.get('Origin');
  if (origin) return ALLOWED_ORIGINS.includes(origin);
  // Some browsers omit Origin on same-navigation GETs; fall back to Referer.
  const referer = request.headers.get('Referer');
  if (referer) return ALLOWED_ORIGINS.some((o) => referer.startsWith(o));
  // No Origin and no Referer (e.g. curl) — let the host/path allowlists gate it.
  return true;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return deny(405, 'Method not allowed');
    }
    if (!originAllowed(request)) {
      return deny(403, 'Origin not allowed');
    }

    const target = new URL(request.url).searchParams.get('u');
    if (!target) {
      return deny(400, 'Missing ?u= parameter');
    }

    let upstream;
    try {
      upstream = new URL(target);
    } catch {
      return deny(400, 'Malformed target URL');
    }

    if (upstream.protocol !== 'https:') {
      return deny(400, 'Only https targets are allowed');
    }
    if (!ALLOWED_HOSTS.has(upstream.hostname)) {
      return deny(403, 'Target host not allowed');
    }
    const path = upstream.pathname.toLowerCase();
    if (!(path.endsWith('.pdf') || path.endsWith('.zip'))) {
      return deny(403, 'Only .pdf/.zip targets are allowed');
    }

    let resp;
    try {
      resp = await fetch(upstream.toString(), {
        headers: { 'User-Agent': 'consensus-pack-proxy' },
        cf: { cacheEverything: true, cacheTtl: 86400 },
      });
    } catch (e) {
      return deny(502, 'Upstream fetch failed: ' + e.message);
    }

    const headers = new Headers(CORS_HEADERS);
    const ctype = resp.headers.get('Content-Type');
    if (ctype) headers.set('Content-Type', ctype);
    const clen = resp.headers.get('Content-Length');
    if (clen) headers.set('Content-Length', clen);
    // Let the browser cache the pack too — packs are immutable once published.
    headers.set('Cache-Control', 'public, max-age=86400');

    return new Response(resp.body, { status: resp.status, headers });
  },
};
