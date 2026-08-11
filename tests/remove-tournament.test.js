// removeTournamentEntry (util/submission.js) — the registry half of the
// maintainer-only tournament-removal flow (scripts/remove_tournament.mjs,
// docs/submission-relay.md). Must handle both entry styles that coexist
// in roster-presets.js: hand-written object literals and the JSON entries
// the submission pipeline inserts.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  removeTournamentEntry,
  insertTournamentEntry,
  buildTournamentEntry,
} from '../src/util/submission.js';

const SOURCE = `// header comment
export const TOURNAMENTS = [
  {
    name: 'First Cup',
    slug: 'first-cup',
    rosters: [
      { name: 'Braces { in } name', players: ['A "quoted" B', "It's C"] },
    ],
  },
  {
    "name": "Second Cup",
    "slug": "second-cup",
    "rosters": []
  },
];

export function after() {}
`;

describe('removeTournamentEntry', () => {
  it('removes a hand-written object-literal entry', () => {
    const out = removeTournamentEntry(SOURCE, 'first-cup');
    expect(out).not.toContain('first-cup');
    expect(out).toContain('second-cup');
    expect(out).toContain('export function after');
  });

  it('removes a pipeline-inserted JSON entry', () => {
    const out = removeTournamentEntry(SOURCE, 'second-cup');
    expect(out).not.toContain('second-cup');
    expect(out).toContain('first-cup');
  });

  it('is quote-aware: braces and quotes inside names cannot desync the walker', () => {
    const out = removeTournamentEntry(SOURCE, 'second-cup');
    // The first entry (with the tricky strings) survives intact.
    expect(out).toContain('Braces { in } name');
    expect(out).toContain('A "quoted" B');
  });

  it('returns null for an unknown slug', () => {
    expect(removeTournamentEntry(SOURCE, 'no-such-slug')).toBe(null);
  });

  it('inverts insertTournamentEntry', () => {
    const entry = buildTournamentEntry({
      name: 'Third Cup', slug: 'third-cup', description: '', rosters: [],
    });
    const inserted = insertTournamentEntry(SOURCE, entry);
    expect(inserted).toContain('third-cup');
    const removed = removeTournamentEntry(inserted, 'third-cup');
    expect(removed).toBe(SOURCE);
  });

  it('leaves syntactically valid JS behind', () => {
    const out = removeTournamentEntry(SOURCE, 'first-cup');
    // new Function can't take module syntax; strip `export` for the parse check.
    expect(() => new Function(out.replace(/^export /gm, ''))).not.toThrow();
  });

  it('works against the real roster-presets.js for every registered slug', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'roster-presets.js'), 'utf8');
    const slugs = [...source.matchAll(/["']?slug["']?\s*:\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      const out = removeTournamentEntry(source, slug);
      expect(out, `removing ${slug}`).not.toBe(null);
      expect(out).not.toContain(`'${slug}'`);
      expect(out).not.toContain(`"${slug}"`);
      expect(() => new Function(out.replace(/^export /gm, ''))).not.toThrow();
    }
  });
});
