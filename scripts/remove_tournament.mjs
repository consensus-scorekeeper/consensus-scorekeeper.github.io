// Removes a tournament from the site: its tournaments/<slug>/ folder
// (stats page + published results) and its TOURNAMENTS registry entry in
// src/ui/roster-presets.js. Driven by the maintainer-only
// remove-tournament workflow (Actions tab → "Remove tournament"), or run
// locally:
//
//   node scripts/remove_tournament.mjs <slug>
//
// The Worker-side cleanup (deleting the slug's publishing-key hash) is
// the workflow's job — see docs/submission-relay.md for why a stale hash
// must not outlive the tournament.
//
// Tolerates partial states (registry entry without folder or vice versa,
// e.g. a half-merged creation): removes whatever exists, fails only if
// there is nothing at all to remove.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidTournamentSlug, removeTournamentEntry } from '../src/util/submission.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = (process.argv[2] || '').trim();

if (!isValidTournamentSlug(slug)) {
  console.error(`Invalid tournament slug: "${slug}"`);
  process.exit(1);
}

let removedSomething = false;

const presetsPath = path.join(repoRoot, 'src', 'ui', 'roster-presets.js');
const updated = removeTournamentEntry(fs.readFileSync(presetsPath, 'utf8'), slug);
if (updated !== null) {
  fs.writeFileSync(presetsPath, updated);
  console.log(`Removed "${slug}" from the TOURNAMENTS registry.`);
  removedSomething = true;
} else {
  console.log(`No "${slug}" entry in the TOURNAMENTS registry.`);
}

const folder = path.join(repoRoot, 'tournaments', slug);
if (fs.existsSync(folder)) {
  fs.rmSync(folder, { recursive: true });
  console.log(`Deleted tournaments/${slug}/.`);
  removedSomething = true;
} else {
  console.log(`No tournaments/${slug}/ folder.`);
}

if (!removedSomething) {
  console.error(`Nothing to remove — is "${slug}" the right slug?`);
  process.exit(1);
}
