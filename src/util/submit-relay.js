// Client for the submit-relay Worker (workers/submit-relay/) — the
// no-GitHub-account front door to the results-submission pipeline. Full
// design + trust model: docs/submission-relay.md.
//
// SUBMIT_RELAY_BASE empty ⇒ the relay is disabled and every intake link
// falls back to the GitHub issue form (util/submit-results.js), same
// convention as PACK_PROXY_BASE in ui/pack-browser.js. Point it at the
// deployed Worker URL (no trailing slash) to turn the in-page form on.
//
// Publishing keys (one shared secret per tournament, distributed by the
// TD to their moderators) are remembered per-slug in localStorage, so a
// device enters its key once. Only ever sent to SUBMIT_RELAY_BASE.

export const SUBMIT_RELAY_BASE = 'https://consensus-submit-relay.denisliu10.workers.dev';

// Canonical site origin — only for building shareable key-handout links
// (like SUBMISSIONS_REPO in submit-results.js, never for page-internal
// URLs, which must stay relative).
export const SITE_BASE = 'https://consensus-scorekeeper.github.io';

// Cloudflare Turnstile site key — empty disables the widget. The Worker
// only enforces Turnstile when ITS secret is set, so these can be turned
// on independently (see workers/submit-relay/README.md).
export const TURNSTILE_SITE_KEY = '';

export function relayEnabled() {
  return SUBMIT_RELAY_BASE !== '';
}

// ---------- publishing-key storage ----------

const KEYS_STORAGE_KEY = 'consensus-tournament-keys-v1';

export function loadPublishingKeys() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYS_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getPublishingKey(slug) {
  return loadPublishingKeys()[slug] || '';
}

// Falsy key deletes the entry. localStorage may be unavailable (private
// mode) — losing key persistence must never break submitting.
export function savePublishingKey(slug, key) {
  try {
    const keys = loadPublishingKeys();
    if (key) keys[slug] = key;
    else delete keys[slug];
    localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify(keys));
  } catch { /* ignore */ }
}

// ---------- relay calls ----------

// Uniform result: { ok, status, data } — data is the Worker's JSON body
// ({ error, details? } on failure), or {} if unreachable/non-JSON, so
// callers can always read .data.error.
async function post(path, payload) {
  let res;
  try {
    res = await fetch(SUBMIT_RELAY_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, status: 0, data: { error: 'Could not reach the submission relay.' } };
  }
  let data = {};
  try { data = await res.json(); } catch { /* keep {} */ }
  return { ok: res.ok, status: res.status, data };
}

// Submit one-or-more games' CSV text. The stored publishing key rides
// along automatically; a verified response (or a brand-new tournament's
// minted key) updates the store, so "enter the key once" holds.
export async function submitResults({ slug, csv, name, description, notes, key, turnstileToken }) {
  const sendKey = key || getPublishingKey(slug);
  const result = await post('/submit', {
    slug, csv, name, description, notes,
    key: sendKey || undefined,
    turnstileToken: turnstileToken || undefined,
  });
  if (result.ok && result.data.newTournamentKey) {
    savePublishingKey(slug, result.data.newTournamentKey);
  } else if (result.ok && result.data.verified && sendKey) {
    savePublishingKey(slug, sendKey);
  }
  return result;
}

export async function removeGame({ slug, filename }) {
  return post('/remove-game', { slug, filename, key: getPublishingKey(slug) });
}

// ---------- key-handout links ----------
// A TD shares ONE link with their moderators; opening it saves the key
// for that slug on the device (stats-main.js) — nobody types slugs or
// keys. The key rides in the URL FRAGMENT so it never reaches a server
// or its logs; preview.html is the target because it exists even before
// the tournament's own page does (and shows the current stats either way).

export function keyHandoutUrl(slug, key) {
  return `${SITE_BASE}/tournaments/preview.html?slug=${slug}#key=${key}`;
}

// '#key=cs_<40 hex>' → the key, else ''. Strict shape check so junk
// fragments can't get persisted as keys.
export function parseKeyFromHash(hash) {
  const m = /^#key=(cs_[0-9a-f]{40})$/.exec(String(hash || ''));
  return m ? m[1] : '';
}
