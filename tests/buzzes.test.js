// Correct-buzz percentage (util/buzzes.js): counted from phone-buzzer
// verdicts — Space / the buzzed player's +10 = correct, Esc = wrong —
// through the real room host, reducers, CSV round trip, aggregate and
// stats viewer.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { state, exportCsv } from '../src/main.js';
import { renderGame } from '../src/ui/game.js';
import { addPoints, undoLast, reorderPlayer, canUndo } from '../src/state.js';
import { rebuildStreakGroups } from '../src/game/streaks.js';
import { _setRoomForTest, handleRemoteBuzz, awardPreselect, dismissPreselect } from '../src/ui/room.js';
import { buzzCounts, buzzPct, formatBuzzCells, parseBuzzCell } from '../src/util/buzzes.js';
import { buildResultsCsv } from '../src/util/csv.js';
import { parseResultsCsv } from '../src/util/parse-results-csv.js';
import { aggregateTournament } from '../src/util/tournament-aggregate.js';
import { setupTournamentStats } from '../src/ui/tournament-stats.js';
import { resetState, makeQ } from './helpers.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const counts = (team, i) => {
  const p = (team === 'a' ? state.teamA : state.teamB).players[i];
  return buzzCounts(state.history, team, i, p);
};

function fakeRoom() {
  return { code: 'TEST', sent: [], send(m) { this.sent.push(m); }, close() {}, playerUrl() { return 'x'; } };
}

describe('pure helpers', () => {
  it('computes the percentage and the blank-when-untracked CSV cells', () => {
    expect(buzzPct(8, 2)).toBe(0.8);
    expect(buzzPct(0, 0)).toBeNull();
    expect(formatBuzzCells({ correct: 3, wrong: 1 })).toEqual([3, 1]);
    expect(formatBuzzCells({ correct: 0, wrong: 0 })).toEqual(['', '']);
    expect(parseBuzzCell('')).toBeNull();
    expect(parseBuzzCell(undefined)).toBeNull();
    expect(parseBuzzCell('0')).toBe(0);
    expect(parseBuzzCell('x')).toBeNull();
  });
});

describe('counting from buzzer verdicts', () => {
  beforeEach(() => {
    resetState();
    state.teamA = { name: 'Alphas', score: 0, players: [{ name: 'Kim', points: 0 }, { name: 'Sam', points: 0 }] };
    state.teamB = { name: 'Bravos', score: 0, players: [{ name: 'Pat', points: 0 }, { name: 'Kai', points: 0 }] };
    state.questions = [];
    for (let n = 1; n <= 6; n++) state.questions.push(makeQ(n));
    state.hasQuestions = true;
    document.getElementById('setup').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    _setRoomForTest(fakeRoom());
    renderGame();
  });
  afterEach(() => _setRoomForTest(null));

  it('Space counts a correct buzz, Esc a wrong one', async () => {
    handleRemoteBuzz('Pat');
    await tick();
    expect(document.getElementById('room-buzz-bar').textContent).toContain('Esc wrong');
    dismissPreselect();
    expect(counts('b', 0)).toEqual({ correct: 0, wrong: 1 });

    handleRemoteBuzz('Kim');
    await tick();
    awardPreselect();
    expect(counts('a', 0)).toEqual({ correct: 1, wrong: 0 });
    expect(document.querySelector('#panel-a .player-buzzes').textContent).toBe('1/1');
    expect(document.querySelector('#panel-b .player-buzzes').textContent).toBe('0/1');
  });

  it("the buzzed player's +10 counts; scoring someone else counts nothing", async () => {
    handleRemoteBuzz('Kim');
    await tick();
    addPoints('a', 0, 10);
    expect(counts('a', 0).correct).toBe(1);

    handleRemoteBuzz('Pat');
    await tick();
    addPoints('b', 1, 10); // moderator gave it to Kai instead
    expect(counts('b', 0)).toEqual({ correct: 0, wrong: 0 });
    expect(counts('b', 1)).toEqual({ correct: 0, wrong: 0 });
  });

  it('number-key scoring without a buzz leaves the row untouched', () => {
    addPoints('a', 1, 10);
    expect(counts('a', 1)).toEqual({ correct: 0, wrong: 0 });
    expect(document.querySelector('#panel-a .player-buzzes')).toBeNull();
  });

  it('an unmatched buzz dismissed with Esc is not counted', async () => {
    handleRemoteBuzz('Stranger');
    await tick();
    dismissPreselect();
    for (const t of ['a', 'b']) for (const i of [0, 1]) expect(counts(t, i).wrong).toBe(0);
  });

  it('streaks are left out', async () => {
    state.questions[0] = makeQ(1, { streakRange: { start: 1, end: 2 } });
    state.questions[1] = makeQ(2, { question: '' });
    state.questions[0].isStreak = true; state.questions[0].streakGroupStart = 0;
    state.questions[1].isStreak = true; state.questions[1].streakGroupStart = 0;
    rebuildStreakGroups();
    renderGame();
    handleRemoteBuzz('Kim');
    await tick();
    expect(document.getElementById('room-buzz-bar').textContent).toContain('Esc dismisses');
    dismissPreselect();
    handleRemoteBuzz('Kim');
    await tick();
    awardPreselect();
    expect(counts('a', 0)).toEqual({ correct: 0, wrong: 0 });
  });

  it('Ctrl+Z takes back the newest action, wrong buzz or score', async () => {
    handleRemoteBuzz('Kim');
    await tick();
    awardPreselect();               // Q1: Kim correct
    handleRemoteBuzz('Pat');
    await tick();
    dismissPreselect();             // Q2: Pat wrong
    handleRemoteBuzz('Sam');
    await tick();
    awardPreselect();               // Q2: Sam correct

    undoLast();                     // Sam's points
    expect(counts('a', 1).correct).toBe(0);
    expect(counts('b', 0).wrong).toBe(1);
    undoLast();                     // Pat's wrong buzz
    expect(counts('b', 0).wrong).toBe(0);
    expect(counts('a', 0).correct).toBe(1);
    undoLast();                     // Kim's points
    expect(counts('a', 0).correct).toBe(0);
    expect(canUndo()).toBe(false);
  });

  it('a lone wrong buzz enables Undo', async () => {
    handleRemoteBuzz('Pat');
    await tick();
    dismissPreselect();
    expect(canUndo()).toBe(true);
    expect(document.getElementById('undo-btn').disabled).toBe(false);
  });

  it('counts follow the player through drag-reorder', async () => {
    handleRemoteBuzz('Kim');
    await tick();
    awardPreselect();
    handleRemoteBuzz('Kim');
    await tick();
    dismissPreselect();
    reorderPlayer('a', 0, 1);
    expect(state.teamA.players[1].name).toBe('Kim');
    expect(counts('a', 1)).toEqual({ correct: 1, wrong: 1 });
    expect(counts('a', 0)).toEqual({ correct: 0, wrong: 0 });
  });

  it('exports Correct/Wrong, blank for players without buzzes, and round-trips', async () => {
    handleRemoteBuzz('Kim');
    await tick();
    awardPreselect();
    handleRemoteBuzz('Pat');
    await tick();
    dismissPreselect();
    const csv = buildResultsCsv(state);
    const lines = csv.split('\r\n');
    const i = lines.indexOf('Player,Team,Points,Played,Correct,Wrong');
    expect(lines.slice(i + 1, i + 5)).toEqual(['Kim,Alphas,10,1,1,0', 'Sam,Alphas,0,1,,', 'Pat,Bravos,0,1,0,1', 'Kai,Bravos,0,1,,']);
    const parsed = parseResultsCsv(csv);
    expect(parsed.players.map((p) => [p.buzzCorrect, p.buzzWrong])).toEqual([[1, 0], [null, null], [0, 1], [null, null]]);
  });
});

// ---- stats ----

const header = (pack, a, b, sa, sb) => [
  `Packet,${pack}`, `Team A,${a}`, `Team B,${b}`, `Final Score,${a} ${sa} - ${sb} ${b}`, 'Winner,x', 'Exported,2026-01-01T00:00:00Z', '',
  'Team,Score', `${a},${sa}`, `${b},${sb}`, '',
];
const CSV_BUZZ = [...header('Pack 1', 'X', 'Y', 90, 20),
  'Player,Team,Points,Played,Correct,Wrong', 'Ann,X,80,1,8,2', 'Al,X,10,1,1,0', 'Bo,Y,20,1,2,3', 'Cy,Y,0,1,,',
].join('\r\n');
const CSV_OLD = [...header('Pack 2', 'X', 'Y', 10, 20),
  'Player,Team,Points,Played', 'Ann,X,10,1', 'Al,X,0,1', 'Bo,Y,20,1', 'Cy,Y,0,1',
].join('\r\n');

describe('aggregate', () => {
  it('sums tracked games only and flags whether any buzz data exists', () => {
    const agg = aggregateTournament([parseResultsCsv(CSV_BUZZ), parseResultsCsv(CSV_OLD)]);
    const ann = agg.leaderboard.find((p) => p.name === 'Ann');
    expect([ann.buzzCorrect, ann.buzzWrong]).toEqual([8, 2]);
    const y = agg.standings.find((t) => t.name === 'Y');
    expect([y.buzzCorrect, y.buzzWrong]).toEqual([2, 3]);
    expect(agg.hasBuzzData).toBe(true);
    expect(aggregateTournament([parseResultsCsv(CSV_OLD)]).hasBuzzData).toBe(false);
  });
});

describe('stats viewer', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const content = () => document.getElementById('ts-content');
  const panel = (i) => content().querySelectorAll('.ts-panel')[i];
  const headers = (i) => [...panel(i).querySelectorAll('thead th')].map((th) => th.textContent);
  const rows = (i) => [...panel(i).querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()));

  async function load(files) {
    document.body.innerHTML = `<div id="tournament-stats-section"><span id="ts-status"></span><div id="ts-content"></div></div>`;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      const ok = (body) => ({ ok: true, json: async () => JSON.parse(body), text: async () => body });
      if (u.endsWith('manifest.json')) return ok(JSON.stringify({ games: Object.keys(files) }));
      const name = Object.keys(files).find((f) => u.endsWith(f));
      return name ? ok(files[name]) : { ok: false };
    }));
    setupTournamentStats({ manifestUrl: 'http://x/results/manifest.json' });
    for (let i = 0; i < 10 && !content().querySelector('.ts-table'); i++) await flush();
    const back = content().querySelector('[data-action="ts-show-standings"]');
    if (back) back.click();
  }
  afterEach(() => vi.unstubAllGlobals());

  it('adds Buzz % with a 10-buzz minimum and counts on hover', async () => {
    await load({ 'buzz.csv': CSV_BUZZ, 'old.csv': CSV_OLD });
    expect(headers(0)).toContain('Buzz %');
    expect(headers(1)).toEqual(['#', 'Player', 'Team', 'Pts', 'GP', 'PPG', 'Buzz %', 'Best']);
    const lb = rows(1);
    const ann = lb.find((r) => r[1] === 'Ann');
    expect(ann[6]).toBe('80%');
    expect(lb.find((r) => r[1] === 'Bo')[6]).toBe('—'); // 5 buzzes: under the minimum
    expect(lb.find((r) => r[1] === 'Cy')[6]).toBe('—');
    const annCell = [...panel(1).querySelectorAll('tbody tr')].find((tr) => tr.children[1].textContent === 'Ann').children[6];
    expect(annCell.querySelector('span').title).toBe('8 of 10 buzzes correct');
  });

  it('shows per-game counts on the game view', async () => {
    await load({ 'buzz.csv': CSV_BUZZ });
    content().querySelector('[data-action="ts-show-player"][data-player="Ann"]').click();
    content().querySelector('[data-action="ts-show-game"]').click();
    expect(headers(0)).toEqual(['Player', 'Points', 'Buzzes']);
    expect(rows(0)[0]).toEqual(['Ann', '80', '8/10']);
    expect(rows(1).find((r) => r[0] === 'Cy')[2]).toBe('—');
    // The viewer's view state is module-level; leave it on standings.
    content().querySelector('[data-action="ts-show-standings"]').click();
  });

  it('leaves tournaments without buzz data unchanged', async () => {
    await load({ 'old.csv': CSV_OLD });
    expect(headers(1)).toEqual(['#', 'Player', 'Team', 'Pts', 'GP', 'PPG', 'Best']);
    expect(headers(0)).not.toContain('Buzz %');
  });
});
