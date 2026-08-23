import { describe, it, expect } from 'vitest';
import { parseResultsCsv } from '../src/util/parse-results-csv.js';
import { buildResultsCsv } from '../src/util/csv.js';

const SAMPLE_CSV = [
  'Packet,My Pack.pdf',
  'Team A,Alphas',
  'Team B,Bravos',
  'Final Score,Alphas 40 - 20 Bravos',
  'Winner,Alphas',
  'Exported,2026-05-09T12:00:00.000Z',
  '',
  'Team,Score',
  'Alphas,40',
  'Bravos,20',
  '',
  'Player,Team,Points',
  'Alice,Alphas,30',
  'Andy,Alphas,10',
  'Bob,Bravos,20',
].join('\r\n');

describe('parseResultsCsv', () => {
  it('extracts metadata, scores, and players from a buildResultsCsv-shaped string', () => {
    const r = parseResultsCsv(SAMPLE_CSV);
    expect(r.packet).toBe('My Pack.pdf');
    expect(r.teamA).toBe('Alphas');
    expect(r.teamB).toBe('Bravos');
    expect(r.scoreA).toBe(40);
    expect(r.scoreB).toBe(20);
    expect(r.winner).toBe('Alphas');
    expect(r.exportedAt).toBe('2026-05-09T12:00:00.000Z');
    expect(r.players).toEqual([
      { name: 'Alice', team: 'Alphas', points: 30, played: 1 },
      { name: 'Andy', team: 'Alphas', points: 10, played: 1 },
      { name: 'Bob', team: 'Bravos', points: 20, played: 1 },
    ]);
  });

  it('reads the Played column when present (post-substitutions format)', () => {
    const csv = SAMPLE_CSV
      .replace('Player,Team,Points', 'Player,Team,Points,Played')
      .replace('Alice,Alphas,30', 'Alice,Alphas,30,1')
      .replace('Andy,Alphas,10', 'Andy,Alphas,10,0.5')
      .replace('Bob,Bravos,20', 'Bob,Bravos,20,0.381');
    const r = parseResultsCsv(csv);
    expect(r.players.map((p) => p.played)).toEqual([1, 0.5, 0.381]);
  });

  it('treats a blank, garbage, or out-of-range Played cell as a full game / clamps it', () => {
    const csv = SAMPLE_CSV
      .replace('Player,Team,Points', 'Player,Team,Points,Played')
      .replace('Alice,Alphas,30', 'Alice,Alphas,30,')
      .replace('Andy,Alphas,10', 'Andy,Alphas,10,lots')
      .replace('Bob,Bravos,20', 'Bob,Bravos,20,7');
    const r = parseResultsCsv(csv);
    expect(r.players.map((p) => p.played)).toEqual([1, 1, 1]);
  });

  it('round-trips a CSV produced by buildResultsCsv', () => {
    const state = {
      teamA: { name: 'strangers on a chrain', players: [{ name: 'Terry Tang', points: 90 }, { name: 'Richard Niu', points: 80 }], score: 170 },
      teamB: { name: 'Dust of Snow', players: [{ name: 'Lorie Au Yeung', points: 70 }], score: 70 },
      packName: 'Pack 1.pdf',
    };
    const csv = buildResultsCsv(state);
    const parsed = parseResultsCsv(csv);
    expect(parsed.teamA).toBe('strangers on a chrain');
    expect(parsed.teamB).toBe('Dust of Snow');
    expect(parsed.scoreA).toBe(170);
    expect(parsed.scoreB).toBe(70);
    expect(parsed.winner).toBe('strangers on a chrain');
    expect(parsed.players).toHaveLength(3);
    expect(parsed.players[0]).toEqual({ name: 'Terry Tang', team: 'strangers on a chrain', points: 90, played: 1 });
  });

  it('round-trips a substitution through buildResultsCsv', () => {
    const state = {
      teamA: { name: 'A', players: [{ name: 'Full', points: 50 }, { name: 'Half', points: 20, subs: [{ out: 50, in: null }] }], score: 70 },
      teamB: { name: 'B', players: [{ name: 'Late', points: 10, subs: [{ out: 0, in: 40 }] }], score: 10 },
      packName: 'Pack 1.pdf',
      questions: Array.from({ length: 100 }, (_, i) => ({ num: i + 1 })),
    };
    const parsed = parseResultsCsv(buildResultsCsv(state));
    expect(parsed.players).toEqual([
      { name: 'Full', team: 'A', points: 50, played: 1 },
      { name: 'Half', team: 'A', points: 20, played: 0.5 },
      { name: 'Late', team: 'B', points: 10, played: 0.6 },
    ]);
  });

  it('handles a UTF-8 BOM and CRLF line endings', () => {
    const withBom = '﻿' + SAMPLE_CSV;
    const r = parseResultsCsv(withBom);
    expect(r.teamA).toBe('Alphas');
  });

  it('handles quoted fields containing a comma', () => {
    const csv = [
      'Packet,"Pack, with comma.pdf"',
      'Team A,A',
      'Team B,B',
      'Final Score,A 0 - 0 B',
      'Winner,Tie',
      'Exported,2026-05-09T12:00:00.000Z',
      '',
      'Team,Score',
      'A,0',
      'B,0',
      '',
      'Player,Team,Points',
      '"Smith, John",A,0',
    ].join('\r\n');
    const r = parseResultsCsv(csv);
    expect(r.packet).toBe('Pack, with comma.pdf');
    expect(r.players[0].name).toBe('Smith, John');
  });

  it('falls back to deriving winner when the field is absent', () => {
    const csv = SAMPLE_CSV.replace('Winner,Alphas\r\n', '');
    const r = parseResultsCsv(csv);
    expect(r.winner).toBe('Alphas'); // 40 > 20
  });
});
