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
  const sanitize = (s) => String(s || '').replace(/[^a-z0-9 _-]/gi, '_').trim();
  const packBase =
    sanitize(String(parsed.packet || 'consensus-stats').replace(/\.pdf$/i, '')) ||
    'consensus-stats';
  const matchup = `${sanitize(parsed.teamA) || 'TeamA'} vs ${sanitize(parsed.teamB) || 'TeamB'}`;
  return `${packBase} - ${matchup}.csv`;
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
