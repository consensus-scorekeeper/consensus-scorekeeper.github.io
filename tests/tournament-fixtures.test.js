// Integration check against the real CSVs under tournaments/<slug>/results/.
// Every published game must parse, each tournament's manifest must stay
// in sync with its folder, and aggregateTournament must run end-to-end
// without errors. Each tournament gets its own describe() block so the
// failure message points at the right folder.
//
// These assertions are intentionally structural (counts derived from the
// data, not hardcoded), so new tournaments / packs can be added by simply
// creating tournaments/<new-slug>/results/ — no test edit required.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseResultsCsv } from '../src/util/parse-results-csv.js';
import { aggregateTournament } from '../src/util/tournament-aggregate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOURNAMENTS_DIR = path.join(here, '..', 'tournaments');

function listTournamentSlugs() {
  if (!existsSync(TOURNAMENTS_DIR)) return [];
  return readdirSync(TOURNAMENTS_DIR)
    .filter((name) => {
      const sub = path.join(TOURNAMENTS_DIR, name);
      return statSync(sub).isDirectory() && existsSync(path.join(sub, 'results'));
    })
    .sort();
}

function loadGames(slug) {
  const dir = path.join(TOURNAMENTS_DIR, slug, 'results');
  const files = readdirSync(dir).filter((f) => f.endsWith('.csv'));
  return files.map((name) => {
    const text = readFileSync(path.join(dir, name), 'utf-8');
    return { id: name, ...parseResultsCsv(text) };
  });
}

function loadManifest(slug) {
  const manifestPath = path.join(TOURNAMENTS_DIR, slug, 'results', 'manifest.json');
  return JSON.parse(readFileSync(manifestPath, 'utf-8'));
}

const slugs = listTournamentSlugs();

describe('tournament-results fixtures', () => {
  it('at least one tournament folder exists', () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  for (const slug of slugs) {
    describe(`tournaments/${slug}/`, () => {
      const games = loadGames(slug);

      // A tournament can legitimately hold zero games: the submission
      // pipeline creates the folder with the first submission, and the
      // removal workflow can retract every game again. The structural
      // checks below degrade to "empty in, empty out" for those.
      it('has a results folder with a manifest', () => {
        expect(existsSync(path.join(TOURNAMENTS_DIR, slug, 'results', 'manifest.json'))).toBe(true);
      });

      it('every game parses with non-empty teams, both scores, and player rows', () => {
        for (const g of games) {
          expect(g.teamA, g.id).toBeTruthy();
          expect(g.teamB, g.id).toBeTruthy();
          expect(Number.isInteger(g.scoreA), g.id).toBe(true);
          expect(Number.isInteger(g.scoreB), g.id).toBe(true);
          expect(g.players.length, g.id).toBeGreaterThan(0);
        }
      });

      it('manifest.json lists every CSV in the folder', () => {
        const manifest = loadManifest(slug);
        const csvFiles = readdirSync(path.join(TOURNAMENTS_DIR, slug, 'results'))
          .filter((f) => f.endsWith('.csv'))
          .sort();
        expect(manifest.games.slice().sort()).toEqual(csvFiles);
      });

      it('aggregates without error and totalGames matches the fixture count', () => {
        const agg = aggregateTournament(games);
        expect(agg.summary.totalGames).toBe(games.length);
        expect(agg.standings.length > 0).toBe(games.length > 0);
        for (const team of agg.standings) {
          expect(team.gamesPlayed, team.name).toBeGreaterThan(0);
        }
      });

      it('total wins across the field equals games minus ties', () => {
        const agg = aggregateTournament(games);
        const totalWins = agg.standings.reduce((s, t) => s + t.wins, 0);
        const totalTies = agg.standings.reduce((s, t) => s + t.ties, 0);
        // Each non-tie game contributes 1 win + 1 loss; each tie contributes
        // 0 wins on both sides, so totalWins = games − ties/2.
        expect(totalWins).toBe(games.length - totalTies / 2);
      });
    });
  }
});
