// Parse a single results CSV (output of util/csv.js's buildResultsCsv) back
// into a structured object. The CSV has three sections separated by blank
// lines:
//   1. metadata key/value rows: Packet, Team A, Team B, Final Score, Winner, Exported
//   2. team-score rows: header "Team,Score" then one row per team
//   3. per-player rows: header "Player,Team,Points" then one row per player
//
// Pure — no DOM, no IO. Tests live in tests/parse-results-csv.test.js.

export function splitCsvLine(line) {
  // RFC 4180-ish split: respect double-quoted fields and "" escapes.
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

export function parseResultsCsv(text) {
  const cleaned = String(text || '')
    .replace(/^﻿/, '')          // strip BOM (exportCsv writes one)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const rows = cleaned.split('\n').map(splitCsvLine);

  const meta = {};
  const teamScores = [];
  const players = [];
  let section = 'meta';

  for (const row of rows) {
    const isBlank = row.every((c) => c === '');
    if (isBlank) continue;

    // Section transitions are signalled by header rows.
    if (row[0] === 'Team' && row[1] === 'Score') { section = 'team-score'; continue; }
    if (row[0] === 'Player' && row[1] === 'Team' && row[2] === 'Points') { section = 'players'; continue; }

    if (section === 'meta') {
      meta[row[0]] = row[1] ?? '';
    } else if (section === 'team-score') {
      teamScores.push({ name: row[0], score: parseInt(row[1], 10) || 0 });
    } else if (section === 'players') {
      players.push({ name: row[0], team: row[1], points: parseInt(row[2], 10) || 0 });
    }
  }

  const teamA = meta['Team A'] || '';
  const teamB = meta['Team B'] || '';
  const scoreA = (teamScores.find((t) => t.name === teamA) || {}).score ?? 0;
  const scoreB = (teamScores.find((t) => t.name === teamB) || {}).score ?? 0;

  const winner = meta['Winner'] || (
    scoreA === scoreB ? 'Tie' : (scoreA > scoreB ? teamA : teamB)
  );

  return {
    packet: meta['Packet'] || '',
    teamA,
    teamB,
    scoreA,
    scoreB,
    winner,
    exportedAt: meta['Exported'] || '',
    players,
  };
}
