// The stats viewer (ui/tournament-stats.js) with substitutions in the
// data: fractional GP in the leaderboard, and the Played column that only
// appears on game / player views where someone was subbed. Drives the real
// viewer against a mocked manifest + CSV fetch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTournamentStats } from '../src/ui/tournament-stats.js';

const CSV_WITH_SUB = [
  'Packet,Pack 1', 'Team A,X', 'Team B,Y', 'Final Score,X 30 - 10 Y', 'Winner,X', 'Exported,2026-01-01T00:00:00Z', '',
  'Team,Score', 'X,30', 'Y,10', '',
  'Player,Team,Points,Played', 'Ann,X,20,0.5', 'Al,X,10,1', 'Bo,Y,10,1',
].join('\r\n');
const CSV_OLD_FORMAT = [
  'Packet,Pack 2', 'Team A,X', 'Team B,Y', 'Final Score,X 10 - 20 Y', 'Winner,Y', 'Exported,2026-01-02T00:00:00Z', '',
  'Team,Score', 'X,10', 'Y,20', '',
  'Player,Team,Points', 'Ann,X,10', 'Al,X,0', 'Bo,Y,20',
].join('\r\n');

const flush = () => new Promise((r) => setTimeout(r, 0));
const content = () => document.getElementById('ts-content');
const rowsOf = (panelIdx) => [...content().querySelectorAll('.ts-panel')[panelIdx].querySelectorAll('tbody tr')]
  .map((tr) => [...tr.children].map((td) => td.textContent.trim()));
const headersOf = (panelIdx) => [...content().querySelectorAll('.ts-panel')[panelIdx].querySelectorAll('thead th')].map((th) => th.textContent);

beforeEach(async () => {
  document.body.innerHTML = `<div id="tournament-stats-section"><span id="ts-status"></span><div id="ts-content"></div></div>`;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, json: async () => JSON.parse(body), text: async () => body });
    if (u.endsWith('manifest.json')) return ok(JSON.stringify({ games: ['sub.csv', 'old.csv'] }));
    if (u.endsWith('sub.csv')) return ok(CSV_WITH_SUB);
    if (u.endsWith('old.csv')) return ok(CSV_OLD_FORMAT);
    return { ok: false };
  }));
  setupTournamentStats({ manifestUrl: 'http://x/results/manifest.json' });
  for (let i = 0; i < 10 && !content().querySelector('.ts-table'); i++) await flush();
  // The viewer's view state is module-level; start every test on standings.
  const back = content().querySelector('[data-action="ts-show-standings"]');
  if (back) back.click();
});

afterEach(() => vi.unstubAllGlobals());

describe('standings view', () => {
  it('shows fractional GP for the subbed player and whole numbers for everyone else', () => {
    const lb = rowsOf(1); // [#, Player, Team, Pts, GP, PPG, Best]
    const ann = lb.find((r) => r[1] === 'Ann');
    const al = lb.find((r) => r[1] === 'Al');
    expect(ann.slice(3, 6)).toEqual(['30', '1.5', '20.0']);
    expect(al.slice(3, 6)).toEqual(['10', '2', '5.0']);
  });
});

describe('game view', () => {
  it('adds a Played column only for a game with a substitution', () => {
    content().querySelector('[data-action="ts-show-team"][data-team="X"]').click();
    const gameRows = [...content().querySelectorAll('[data-action="ts-show-game"]')];
    gameRows.find((r) => r.textContent.includes('Pack 1')).click();
    expect(headersOf(0)).toEqual(['Player', 'Points', 'Played']);
    expect(rowsOf(0)).toEqual([['Ann', '20', '50%'], ['Al', '10', '100%']]);

    content().querySelector('[data-action="ts-show-team"][data-team="X"]').click();
    [...content().querySelectorAll('[data-action="ts-show-game"]')].find((r) => r.textContent.includes('Pack 2')).click();
    expect(headersOf(0)).toEqual(['Player', 'Points']);
  });
});

describe('player view', () => {
  it('shows per-game Played and the fractional GP total', () => {
    content().querySelector('[data-action="ts-show-player"][data-player="Ann"]').click();
    expect(content().querySelector('.ts-team-meta').textContent).toContain('1.5 GP');
    expect(headersOf(0)).toEqual(['Packet', 'Opponent', 'Pts', 'Played', 'Team Score', 'Result']);
    expect(rowsOf(0).map((r) => r[3])).toEqual(['50%', '100%']);
  });

  it('omits Played for a player never subbed', () => {
    content().querySelector('[data-action="ts-show-player"][data-player="Bo"]').click();
    expect(headersOf(0)).toEqual(['Packet', 'Opponent', 'Pts', 'Team Score', 'Result']);
  });
});
