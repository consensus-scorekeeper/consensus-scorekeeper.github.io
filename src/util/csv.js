// Pure CSV builders for the export-results feature. Splitting the
// builder from the download trigger keeps the format unit-testable
// without a DOM (and the multi-section layout — metadata, teams,
// per-player rows — is what tests assert against).

import { csvEscape } from './escape.js';
import { playedFraction, formatPlayed } from './participation.js';

// Per-player rows carry `Played` — the fraction of the game's slots the
// player was on the floor for (1 unless subbed out; see
// util/participation.js). parseResultsCsv treats a missing column as 1, so
// CSVs exported before the column existed still load.
export function buildResultsCsv(state) {
  const winner = state.teamA.score === state.teamB.score
    ? 'Tie'
    : (state.teamA.score > state.teamB.score ? state.teamA.name : state.teamB.name);
  const rows = [];
  rows.push(['Packet', state.packName || '(no packet loaded)']);
  rows.push(['Team A', state.teamA.name]);
  rows.push(['Team B', state.teamB.name]);
  rows.push(['Final Score', `${state.teamA.name} ${state.teamA.score} - ${state.teamB.score} ${state.teamB.name}`]);
  rows.push(['Winner', winner]);
  rows.push(['Exported', new Date().toISOString()]);
  rows.push([]);
  rows.push(['Team', 'Score']);
  rows.push([state.teamA.name, state.teamA.score]);
  rows.push([state.teamB.name, state.teamB.score]);
  rows.push([]);
  rows.push(['Player', 'Team', 'Points', 'Played']);
  const played = (p) => formatPlayed(playedFraction(p, state.questions));
  for (const p of state.teamA.players) rows.push([p.name, state.teamA.name, p.points, played(p)]);
  for (const p of state.teamB.players) rows.push([p.name, state.teamB.name, p.points, played(p)]);
  return rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
}

export function buildResultsFilename(state) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sanitize = s => String(s || '').replace(/[^a-z0-9 _-]/gi, '_').trim();
  const packBase = sanitize((state.packName || 'consensus-stats').replace(/\.pdf$/i, '')) || 'consensus-stats';
  const matchup = `${sanitize(state.teamA.name) || 'TeamA'} vs ${sanitize(state.teamB.name) || 'TeamB'}`;
  return `${packBase} - ${matchup} - ${stamp}.csv`;
}
