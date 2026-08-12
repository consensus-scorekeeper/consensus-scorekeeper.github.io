// Mint (or rotate) a tournament's publishing key — the maintainer's
// "Path B": pre-approve a slug for a TD before any games exist, or
// replace a lost/leaked key. See docs/submission-relay.md.
//
//   node scripts/mint_key.mjs <slug>
//
// Prints the new ACTIVE key once; hand it to the TD. Minting IS the
// approval: for a fresh slug their first submission auto-creates the
// tournament, and every submission publishes automatically — no merges.
// Minting ahead of time also reserves the slug: the relay won't hand a
// competing key to whoever submits under it first.
//
// ⚠️ If the slug already has a key, this REPLACES it — the old key
// stops working immediately (that's the lost/leaked-key recovery).
//
// Admin secret (never committed): the RELAY_ADMIN_SECRET environment
// variable, or the git-ignored file workers/submit-relay/.admin-secret —
// create it once with:
//   echo <secret> > workers/submit-relay/.admin-secret

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidTournamentSlug } from '../src/util/submission.js';
import { SUBMIT_RELAY_BASE, keyHandoutUrl } from '../src/util/submit-relay.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = (process.argv[2] || '').trim();

if (!isValidTournamentSlug(slug)) {
  console.error('Usage: node scripts/mint_key.mjs <slug>');
  console.error('Slug must be lowercase letters, numbers, hyphens (e.g. bay-area-open-2026).');
  process.exit(1);
}
if (!SUBMIT_RELAY_BASE) {
  console.error('SUBMIT_RELAY_BASE is empty in src/util/submit-relay.js — no relay to talk to.');
  process.exit(1);
}

let secret = (process.env.RELAY_ADMIN_SECRET || '').trim();
const secretFile = path.join(repoRoot, 'workers', 'submit-relay', '.admin-secret');
if (!secret && fs.existsSync(secretFile)) {
  secret = fs.readFileSync(secretFile, 'utf8').trim();
}
if (!secret) {
  console.error('No admin secret found. Set RELAY_ADMIN_SECRET, or create the');
  console.error('git-ignored file workers/submit-relay/.admin-secret containing it.');
  process.exit(1);
}

const res = await fetch(SUBMIT_RELAY_BASE + '/admin/rotate', {
  method: 'POST',
  headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ slug }),
});
const data = await res.json().catch(() => ({}));
if (!res.ok || !data.key) {
  console.error(`Relay refused (${res.status}): ${data.error || 'unknown error'}`);
  process.exit(1);
}

console.log(`Publishing key for ${slug} (active immediately; any previous key is now dead):`);
console.log();
console.log(`  ${data.key}`);
console.log();
console.log('Easiest handoff — send the TD this setup link (opening it saves the key');
console.log('on their device; they share the same link with their room moderators):');
console.log();
console.log(`  ${keyHandoutUrl(slug, data.key)}`);
console.log();
console.log('With the key on a device, submissions on the stats site publish');
console.log('automatically — including the first one for a new slug, which creates');
console.log('the tournament stats page on the spot (minting this key was the approval).');
