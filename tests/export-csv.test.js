import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state, exportCsv } from '../src/main.js';
import { resetState } from './helpers.js';

beforeEach(resetState);

// exportCsv triggers a download by creating a Blob and clicking an <a>. Spy
// on URL.createObjectURL to grab the Blob; spy on the anchor's click() to
// avoid happy-dom navigating. Returns the CSV text (without the BOM prefix).
async function captureExportedCsv() {
  let captured;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    captured = blob;
    return 'blob:fake';
  };
  URL.revokeObjectURL = () => {};

  // Suppress the anchor click's default action
  const origAppend = document.body.appendChild;
  document.body.appendChild = function (node) {
    if (node && node.tagName === 'A') node.click = () => {};
    return origAppend.call(this, node);
  };

  try {
    exportCsv();
    const text = await captured.text();
    return text.replace(/^﻿/, '');
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    document.body.appendChild = origAppend;
  }
}

describe('exportCsv', () => {
  it('produces a multi-section CSV: metadata → teams → players', async () => {
    state.teamA = {
      name: 'Alphas',
      players: [{ name: 'Alice', points: 30 }, { name: 'Andy', points: 10 }],
      score: 40,
    };
    state.teamB = {
      name: 'Bravos',
      players: [{ name: 'Bob', points: 20 }],
      score: 20,
    };
    state.packName = 'My Pack.pdf';

    const csv = await captureExportedCsv();
    const lines = csv.split('\r\n');

    // Section 1: metadata
    expect(lines[0]).toBe('Packet,My Pack.pdf');
    expect(lines[1]).toBe('Team A,Alphas');
    expect(lines[2]).toBe('Team B,Bravos');
    expect(lines[3]).toBe('Final Score,Alphas 40 - 20 Bravos');
    expect(lines[4]).toBe('Winner,Alphas');
    expect(lines[5]).toMatch(/^Exported,\d{4}-\d{2}-\d{2}T/);
    expect(lines[6]).toBe(''); // blank separator

    // Section 2: team scores
    expect(lines[7]).toBe('Team,Score');
    expect(lines[8]).toBe('Alphas,40');
    expect(lines[9]).toBe('Bravos,20');
    expect(lines[10]).toBe('');

    // Section 3: per-player rows
    expect(lines[11]).toBe('Player,Team,Points,Played');
    expect(lines[12]).toBe('Alice,Alphas,30,1');
    expect(lines[13]).toBe('Andy,Alphas,10,1');
    expect(lines[14]).toBe('Bob,Bravos,20,1');
  });

  it('writes each player\'s Played fraction from their sub intervals', async () => {
    state.questions = Array.from({ length: 100 }, (_, i) => ({ num: i + 1, question: 'q' }));
    state.teamA = {
      name: 'Alphas',
      players: [
        { name: 'Alice', points: 30 },                                   // never subbed
        { name: 'Andy', points: 10, subs: [{ out: 50, in: null }] },      // out from Q51 on
        { name: 'Ava', points: 0, subs: [{ out: 0, in: 75 }] },           // in at Q76
      ],
      score: 40,
    };
    state.teamB = { name: 'Bravos', players: [{ name: 'Bob', points: 20, subs: [] }], score: 20 };

    const csv = await captureExportedCsv();
    const lines = csv.split('\r\n');
    expect(lines[12]).toBe('Alice,Alphas,30,1');
    expect(lines[13]).toBe('Andy,Alphas,10,0.5');
    expect(lines[14]).toBe('Ava,Alphas,0,0.25');
    expect(lines[15]).toBe('Bob,Bravos,20,1');
  });

  it('records "Tie" when scores are equal', async () => {
    state.teamA = { name: 'A', players: [], score: 25 };
    state.teamB = { name: 'B', players: [], score: 25 };

    const csv = await captureExportedCsv();
    expect(csv).toContain('Winner,Tie');
  });

  it('records "(no packet loaded)" when packName is null', async () => {
    state.packName = null;
    const csv = await captureExportedCsv();
    expect(csv.split('\r\n')[0]).toBe('Packet,(no packet loaded)');
  });

  it('CSV-escapes team names with commas', async () => {
    state.teamA = { name: 'A, the team', players: [], score: 0 };
    state.teamB = { name: 'B', players: [], score: 0 };

    const csv = await captureExportedCsv();
    const lines = csv.split('\r\n');
    expect(lines[1]).toBe('Team A,"A, the team"');
    expect(lines[3]).toBe('Final Score,"A, the team 0 - 0 B"');
  });
});
