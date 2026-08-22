import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResultsCsv } from '../src/util/parse-results-csv.js';
import { TOURNAMENTS } from '../src/ui/roster-presets.js';
import {
  splitCsvBundle,
  gameIdentityKey,
  canonicalResultsFilename,
  planSubmissionWrites,
  isValidTournamentSlug,
  deriveTournamentName,
  buildRostersFromGames,
  buildTournamentEntry,
  insertTournamentEntry,
  retargetTournamentPage,
} from '../src/util/submission.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeCsv({ packet = 'Pack 1.pdf', teamA = 'Alphas', teamB = 'Bravos', scoreA = 40, scoreB = 20, players } = {}) {
  const playerRows = players || [
    `Alice,${teamA},${scoreA}`,
    `Bob,${teamB},${scoreB}`,
  ];
  return [
    `Packet,${packet}`,
    `Team A,${teamA}`,
    `Team B,${teamB}`,
    `Final Score,${teamA} ${scoreA} - ${scoreB} ${teamB}`,
    `Winner,${scoreA >= scoreB ? teamA : teamB}`,
    'Exported,2026-05-09T12:00:00.000Z',
    '',
    'Team,Score',
    `${teamA},${scoreA}`,
    `${teamB},${scoreB}`,
    '',
    'Player,Team,Points',
    ...playerRows,
  ].join('\r\n');
}

const asGame = (content) => ({ content, parsed: parseResultsCsv(content) });

describe('splitCsvBundle', () => {
  it('returns a single game unchanged (modulo newline normalization)', () => {
    const chunks = splitCsvBundle(makeCsv());
    expect(chunks).toHaveLength(1);
    expect(parseResultsCsv(chunks[0]).teamA).toBe('Alphas');
  });

  it('splits multiple concatenated exports, including BOM-prefixed ones', () => {
    const bundle =
      '﻿' + makeCsv({ packet: 'Pack 1.pdf' }) + '\r\n' +
      '﻿' + makeCsv({ packet: 'Pack 2.pdf', teamA: 'Charlies', teamB: 'Deltas' }) + '\r\n' +
      makeCsv({ packet: 'Pack 3.pdf' });
    const chunks = splitCsvBundle(bundle);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => parseResultsCsv(c).packet)).toEqual([
      'Pack 1.pdf', 'Pack 2.pdf', 'Pack 3.pdf',
    ]);
  });

  it('does not split on a player named "Packet" (3-field row)', () => {
    const csv = makeCsv({ players: ['Packet,Alphas,40', 'Bob,Bravos,20'] });
    expect(splitCsvBundle(csv)).toHaveLength(1);
  });

  it('returns [] for empty/whitespace input', () => {
    expect(splitCsvBundle('')).toEqual([]);
    expect(splitCsvBundle('  \n \r\n')).toEqual([]);
  });
});

describe('gameIdentityKey', () => {
  it('is insensitive to team order, case, and whitespace', () => {
    const a = parseResultsCsv(makeCsv({ teamA: 'Alphas', teamB: 'Bravos' }));
    const b = parseResultsCsv(makeCsv({ teamA: 'BRAVOS', teamB: ' alphas ' }));
    expect(gameIdentityKey(a)).toBe(gameIdentityKey(b));
  });

  it('differs when the packet differs', () => {
    const a = parseResultsCsv(makeCsv({ packet: 'Pack 1.pdf' }));
    const b = parseResultsCsv(makeCsv({ packet: 'Pack 2.pdf' }));
    expect(gameIdentityKey(a)).not.toBe(gameIdentityKey(b));
  });
});

describe('canonicalResultsFilename', () => {
  it('drops the .pdf suffix and has no timestamp', () => {
    const parsed = parseResultsCsv(makeCsv({ packet: 'Pack 1.pdf' }));
    expect(canonicalResultsFilename(parsed)).toBe('Pack 1 - Alphas vs Bravos.csv');
  });

  it('sanitizes characters the exporter also rejects', () => {
    const parsed = parseResultsCsv(makeCsv({ packet: 'Pack: #1?.pdf', teamA: 'A/B' }));
    expect(canonicalResultsFilename(parsed)).toBe('Pack_ _1_ - A_B vs Bravos.csv');
  });

  it('never starts a name component with a Jekyll-ignored character (_ . # ~)', () => {
    // "(no packet loaded)" used to become "_no packet loaded_ - …", which
    // GitHub Pages refused to serve (404 → "1 failed" on the stats page).
    const parsed = parseResultsCsv(makeCsv({ packet: '(no packet loaded)', teamA: '.hidden', teamB: '~tmp' }));
    expect(canonicalResultsFilename(parsed)).toBe('no packet loaded_ - hidden vs tmp.csv');
    const again = parseResultsCsv(makeCsv({ packet: '#1.pdf', teamA: '___x' }));
    expect(canonicalResultsFilename(again)).toBe('1 - x vs Bravos.csv');
  });
});

describe('planSubmissionWrites', () => {
  it('adds a new game under the canonical filename', () => {
    const { writes, warnings } = planSubmissionWrites([], [asGame(makeCsv())]);
    expect(warnings).toEqual([]);
    expect(writes).toEqual([
      { filename: 'Pack 1 - Alphas vs Bravos.csv', content: expect.any(String), action: 'add' },
    ]);
  });

  it('replaces an existing game in place, keeping its (timestamped) filename', () => {
    const published = asGame(makeCsv({ scoreA: 40 }));
    const corrected = asGame(makeCsv({ scoreA: 50 }));
    const { writes } = planSubmissionWrites(
      [{ filename: 'Pack 1 - Alphas vs Bravos - 2026-05-09T12-00-00.csv', parsed: published.parsed }],
      [corrected]
    );
    expect(writes).toEqual([{
      filename: 'Pack 1 - Alphas vs Bravos - 2026-05-09T12-00-00.csv',
      content: corrected.content,
      action: 'update',
    }]);
  });

  it('matches identity even when the re-export swapped Team A and Team B', () => {
    const corrected = asGame(makeCsv({ teamA: 'Bravos', teamB: 'Alphas' }));
    const { writes } = planSubmissionWrites(
      [{ filename: 'old.csv', parsed: parseResultsCsv(makeCsv()) }],
      [corrected]
    );
    expect(writes).toEqual([{ filename: 'old.csv', content: corrected.content, action: 'update' }]);
  });

  it('keeps the last copy when one submission contains the same game twice, with a warning', () => {
    const first = asGame(makeCsv({ scoreA: 40 }));
    const second = asGame(makeCsv({ scoreA: 45 }));
    const { writes, warnings } = planSubmissionWrites([], [first, second]);
    expect(writes).toHaveLength(1);
    expect(writes[0].content).toBe(second.content);
    expect(warnings).toHaveLength(1);
  });

  it('suffixes the canonical name when an unrelated existing file already uses it', () => {
    const unrelated = parseResultsCsv(makeCsv({ packet: 'Other Pack.pdf' }));
    const { writes } = planSubmissionWrites(
      [{ filename: 'Pack 1 - Alphas vs Bravos.csv', parsed: unrelated }],
      [asGame(makeCsv())]
    );
    expect(writes[0].filename).toBe('Pack 1 - Alphas vs Bravos -2.csv');
    expect(writes[0].action).toBe('add');
  });

  it('handles a bulk drop: several new games plus one correction', () => {
    const published = asGame(makeCsv({ packet: 'Pack 1.pdf' }));
    const games = [
      asGame(makeCsv({ packet: 'Pack 1.pdf', scoreA: 55 })),
      asGame(makeCsv({ packet: 'Pack 2.pdf', teamA: 'Charlies', teamB: 'Deltas' })),
      asGame(makeCsv({ packet: 'Pack 3.pdf', teamA: 'Echoes', teamB: 'Foxtrots' })),
    ];
    const { writes } = planSubmissionWrites(
      [{ filename: 'published.csv', parsed: published.parsed }],
      games
    );
    expect(writes.map((w) => w.action).sort()).toEqual(['add', 'add', 'update']);
  });
});

describe('isValidTournamentSlug', () => {
  it('accepts kebab-case slugs', () => {
    expect(isValidTournamentSlug('bay-area-open-2026')).toBe(true);
    expect(isValidTournamentSlug('x')).toBe(true);
  });

  it('rejects anything unsafe as a folder name / URL segment', () => {
    for (const bad of ['', 'Bay Area', 'UPPER', 'a--b', '-lead', 'trail-', '../etc', 'a/b', 'a.b', 'a'.repeat(61)]) {
      expect(isValidTournamentSlug(bad), bad).toBe(false);
    }
  });
});

describe('deriveTournamentName', () => {
  it('title-cases words and leaves numbers alone', () => {
    expect(deriveTournamentName('bay-area-open-2026')).toBe('Bay Area Open 2026');
  });
});

describe('buildRostersFromGames', () => {
  it('unions players per team across games, in appearance order', () => {
    const g1 = parseResultsCsv(makeCsv({
      players: ['Alice,Alphas,30', 'Andy,Alphas,10', 'Bob,Bravos,20'],
    }));
    const g2 = parseResultsCsv(makeCsv({
      teamA: 'Alphas', teamB: 'Charlies',
      players: ['Alice,Alphas,15', 'Ana,Alphas,5', 'Cara,Charlies,25'],
    }));
    expect(buildRostersFromGames([g1, g2])).toEqual([
      { name: 'Alphas', players: ['Alice', 'Andy', 'Ana'] },
      { name: 'Bravos', players: ['Bob'] },
      { name: 'Charlies', players: ['Cara'] },
    ]);
  });
});

describe('insertTournamentEntry', () => {
  it('appends a valid, executable entry to the real roster-presets.js source', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'roster-presets.js'), 'utf8');
    const entry = buildTournamentEntry({
      name: 'Injection "Test" <\'26> ${oops}',
      slug: 'injection-test-26',
      description: 'quotes \' " and `backticks`',
      rosters: [{ name: 'Team </script>', players: ['P1'] }],
    });
    const patched = insertTournamentEntry(source, entry);

    // Execute the patched module source to prove it's still valid JS.
    // (The module has no imports; stripping `export ` keeps declarations.)
    const mod = new Function(
      patched.replace(/^export /gm, '') + '\nreturn { TOURNAMENTS };'
    )();

    const added = mod.TOURNAMENTS.find((t) => t.slug === 'injection-test-26');
    expect(added).toBeTruthy();
    expect(added.name).toBe('Injection "Test" <\'26> ${oops}');
    expect(added.rosters).toEqual([{ name: 'Team </script>', players: ['P1'] }]);
    // Appending must not disturb existing entries.
    expect(mod.TOURNAMENTS[0].slug).toBe(TOURNAMENTS[0].slug);
    expect(mod.TOURNAMENTS.length).toBe(TOURNAMENTS.length + 1);
  });

  it('throws when the source has no TOURNAMENTS array', () => {
    expect(() => insertTournamentEntry('const x = 1;', '{}')).toThrow(/TOURNAMENTS/);
  });
});

describe('retargetTournamentPage', () => {
  it('the template page carries no hardcoded rules-briefing link', () => {
    // Generated pages are copies of this shell; a baked-in link would point
    // at a rules-slides.html the new tournament doesn't have. stats-main.js
    // probes for the file and injects the link at runtime instead.
    const html = fs.readFileSync(
      path.join(repoRoot, 'tournaments', 'stanford-consensus-2026', 'index.html'),
      'utf8'
    );
    expect(html).not.toMatch(/<a [^>]*href="rules-slides\.html"/);
  });

  it('retargets the real template page to a new slug and name', () => {
    const html = fs.readFileSync(
      path.join(repoRoot, 'tournaments', 'stanford-consensus-2026', 'index.html'),
      'utf8'
    );
    const out = retargetTournamentPage(html, { slug: 'bay-area-open-2026', name: 'Bay & Friends $& Open' });
    expect(out).toContain('<meta name="tournament-slug" content="bay-area-open-2026">');
    expect(out).toContain('<title>Bay &amp; Friends $&amp; Open — Stats</title>');
    expect(out).not.toContain('content="stanford-consensus-2026"');
  });
});

describe('planSubmissionWrites (bulk)', () => {
  it('handles a bulk drop: several new games plus one correction', () => {
    const published = asGame(makeCsv({ packet: 'Pack 1.pdf' }));
    const games = [
      asGame(makeCsv({ packet: 'Pack 1.pdf', scoreA: 55 })),
      asGame(makeCsv({ packet: 'Pack 2.pdf', teamA: 'Charlies', teamB: 'Deltas' })),
      asGame(makeCsv({ packet: 'Pack 3.pdf', teamA: 'Echoes', teamB: 'Foxtrots' })),
    ];
    const { writes } = planSubmissionWrites(
      [{ filename: 'published.csv', parsed: published.parsed }],
      games
    );
    expect(writes.map((w) => w.action).sort()).toEqual(['add', 'add', 'update']);
  });
});
