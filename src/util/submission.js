// Pure logic for the results-submission pipeline (the GitHub issue form
// + Action that publishes exported CSVs to tournaments/<slug>/results/).
//
// The scorekeeper's export filename embeds a timestamp, so the same game
// re-exported after a stats fix gets a *different* filename. Filenames
// therefore can't be the identity of a game — the identity is the CSV's
// content: (packet, unordered team pair). planSubmissionWrites uses that
// identity to decide whether a submitted game replaces an existing file
// (a correction) or lands as a new one.
//
// Pure — no DOM, no IO. Consumed by scripts/process-submission.mjs (Node,
// inside the Action) and unit-tested in tests/submission.test.js.

import { splitCsvLine } from './parse-results-csv.js';
import { escapeHtml } from './escape.js';

const BOM = '﻿';

// Split text that may contain several exported CSVs pasted back-to-back
// into one string per game. A new game starts at a `Packet,<name>` line —
// but only once the current chunk has passed its per-player section
// header, so a *player* row for someone named "Packet" (3 fields, not 2)
// can't trigger a false split.
export function splitCsvBundle(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');

  const chunks = [];
  let current = [];
  let inPlayersSection = false;

  for (const rawLine of lines) {
    const line = rawLine.startsWith(BOM) ? rawLine.slice(BOM.length) : rawLine;
    const fields = splitCsvLine(line);
    const startsNewGame =
      inPlayersSection && fields[0] === 'Packet' && fields.length === 2;
    if (startsNewGame) {
      chunks.push(current.join('\n'));
      current = [];
      inPlayersSection = false;
    }
    if (fields[0] === 'Player' && fields[1] === 'Team' && fields[2] === 'Points') {
      inPlayersSection = true;
    }
    current.push(line);
  }
  chunks.push(current.join('\n'));

  return chunks.map((c) => c.trim()).filter((c) => c !== '');
}

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Identity of a game for dedupe/replacement: same packet + same two teams
// (order-insensitive — a re-export could swap which side was Team A).
export function gameIdentityKey(parsed) {
  const teams = [normalize(parsed.teamA), normalize(parsed.teamB)].sort();
  return [normalize(parsed.packet), ...teams].join('|');
}

// Timestamp-free filename for a submitted game. Same sanitization rules as
// util/csv.js's buildResultsFilename, minus the export stamp, so repeated
// submissions of one game map to one stable name.
export function canonicalResultsFilename(parsed) {
  // Leading `_`/`.`/`#`/`~` are stripped after sanitizing: Jekyll (GitHub
  // Pages' default) silently refuses to publish files whose names start
  // with those, so e.g. the "(no packet loaded)" placeholder must not
  // become "_no packet loaded_ - ….csv". (The repo also ships .nojekyll,
  // so this is belt-and-braces for any mirror that still runs Jekyll.)
  const sanitize = (s) =>
    String(s || '').replace(/[^a-z0-9 _-]/gi, '_').replace(/^[_.#~\s]+/, '').trim();
  const packBase =
    sanitize(String(parsed.packet || 'consensus-stats').replace(/\.pdf$/i, '')) ||
    'consensus-stats';
  const matchup = `${sanitize(parsed.teamA) || 'TeamA'} vs ${sanitize(parsed.teamB) || 'TeamB'}`;
  return `${packBase} - ${matchup}.csv`;
}

// ---------- new-tournament creation ----------
// A submission whose slug isn't in the TOURNAMENTS registry creates the
// tournament: a registry entry (rosters derived from the submitted
// games), a stats page, and the results folder — all in the same PR.

// The slug becomes a folder name and a URL path segment, so the pattern
// is strict — it's also what makes path traversal impossible for
// unregistered slugs.
export function isValidTournamentSlug(slug) {
  return typeof slug === 'string'
    && slug.length <= 60
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

// "bay-area-open-2026" → "Bay Area Open 2026". Fallback display name for
// submissions that don't fill in the Tournament-name field.
export function deriveTournamentName(slug) {
  return String(slug)
    .split('-')
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// Derive registry rosters from the submitted games' own team + player
// rows: every team that appears, with its players in appearance order.
export function buildRostersFromGames(parsedGames) {
  const rosters = new Map();
  for (const parsed of parsedGames) {
    for (const team of [parsed.teamA, parsed.teamB]) {
      if (team && !rosters.has(team)) rosters.set(team, new Set());
    }
    for (const p of parsed.players) {
      if (!rosters.has(p.team)) rosters.set(p.team, new Set());
      rosters.get(p.team).add(p.name);
    }
  }
  return [...rosters].map(([name, players]) => ({ name, players: [...players] }));
}

// Serialize a registry entry as JSON — valid JS, and JSON.stringify's
// escaping is what keeps untrusted names/descriptions from injecting
// code into roster-presets.js (which every visitor's browser executes).
export function buildTournamentEntry({ name, slug, description, rosters }) {
  const entry = { name, slug };
  if (description) entry.description = description;
  entry.rosters = rosters;
  return JSON.stringify(entry, null, 2);
}

// Insert an entry (from buildTournamentEntry) at the end of the
// TOURNAMENTS array in roster-presets.js source text. Appending keeps
// the existing entries (and their order) stable.
export function insertTournamentEntry(source, entryJson) {
  const open = source.indexOf('export const TOURNAMENTS = [');
  if (open === -1) throw new Error('TOURNAMENTS array not found in roster-presets.js');
  const close = source.indexOf('\n];', open);
  if (close === -1) throw new Error('TOURNAMENTS array terminator not found');
  const indented = entryJson.split('\n').map((line) => '  ' + line).join('\n');
  return source.slice(0, close) + '\n' + indented + ',' + source.slice(close);
}

// Remove a tournament's entry from roster-presets.js source text — the
// inverse of insertTournamentEntry, used by scripts/remove_tournament.mjs.
// Entries may be hand-written object literals or pipeline-inserted JSON,
// so this walks the array's top-level entries by brace depth (quote-aware:
// team/player names could contain braces) and drops the one whose slug
// matches. Returns null if no entry has that slug.
export function removeTournamentEntry(source, slug) {
  const open = source.indexOf('export const TOURNAMENTS = [');
  if (open === -1) throw new Error('TOURNAMENTS array not found in roster-presets.js');
  const start = source.indexOf('[', open) + 1;
  const close = source.indexOf('\n];', open);
  if (close === -1) throw new Error('TOURNAMENTS array terminator not found');

  let depth = 0;
  let quote = null;
  let entryStart = -1;
  for (let i = start; i < close; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') {
      if (depth === 0) entryStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const entry = source.slice(entryStart, i + 1);
        const m = /["']?slug["']?\s*:\s*["']([^"']*)["']/.exec(entry);
        if (m && m[1] === slug) {
          // Take the trailing comma and surrounding blank space with it.
          let end = i + 1;
          if (source[end] === ',') end++;
          let from = source.lastIndexOf('\n', entryStart);
          if (from === -1) from = entryStart;
          return source.slice(0, from) + source.slice(end);
        }
      }
    }
  }
  return null;
}

// Turn an existing per-tournament stats page into one for a new slug.
// Only the slug <meta> matters functionally (stats-main.js stamps the
// heading at runtime); the static <title> is retargeted for bookmarks
// and link previews. Replacement callbacks avoid `$`-substitution
// surprises from untrusted names.
export function retargetTournamentPage(html, { slug, name }) {
  return html
    .replace(/(<meta name="tournament-slug" content=")[^"]*(">)/, (m, pre, post) => pre + slug + post)
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(name)} — Stats</title>`);
}

// Decide, for each submitted game, which file it should be written to.
//
//   existing — [{ filename, parsed }] for the CSVs already in the target
//              results/ folder (unparseable ones simply omitted).
//   games    — [{ content, parsed }] for the submitted games, in order.
//
// Returns { writes, warnings }:
//   writes   — [{ filename, content, action: 'add' | 'update' }]
//   warnings — human-readable notes (e.g. in-submission duplicates).
//
// Rules: a game matching an existing file's identity overwrites that file
// (keeping its filename, so already-published timestamped names stay put);
// otherwise it gets the canonical filename, suffixed -2/-3 on collision
// with an unrelated existing file. If one submission contains the same
// game twice, the last copy wins.
export function planSubmissionWrites(existing, games) {
  const existingByIdentity = new Map();
  const takenNames = new Set();
  for (const { filename, parsed } of existing) {
    existingByIdentity.set(gameIdentityKey(parsed), filename);
    takenNames.add(filename.toLowerCase());
  }

  const warnings = [];
  const byIdentity = new Map();
  for (const game of games) {
    const key = gameIdentityKey(game.parsed);
    if (byIdentity.has(key)) {
      warnings.push(
        `Duplicate in submission: "${game.parsed.packet}" — ` +
        `${game.parsed.teamA} vs ${game.parsed.teamB} appears more than once; keeping the last copy.`
      );
    }
    byIdentity.set(key, game);
  }

  const writes = [];
  for (const [key, game] of byIdentity) {
    const existingName = existingByIdentity.get(key);
    if (existingName) {
      writes.push({ filename: existingName, content: game.content, action: 'update' });
      continue;
    }
    const base = canonicalResultsFilename(game.parsed);
    let filename = base;
    for (let n = 2; takenNames.has(filename.toLowerCase()); n++) {
      filename = base.replace(/\.csv$/, ` -${n}.csv`);
    }
    takenNames.add(filename.toLowerCase());
    writes.push({ filename, content: game.content, action: 'add' });
  }

  return { writes, warnings };
}
