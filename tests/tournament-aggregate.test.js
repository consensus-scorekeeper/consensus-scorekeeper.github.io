import { describe, it, expect } from 'vitest';
import { aggregateTournament, gamesForTeam, gamesForPlayer } from '../src/util/tournament-aggregate.js';

function game({ id, a, b, scoreA, scoreB, players = [] }) {
  return {
    id, packet: id, teamA: a, teamB: b, scoreA, scoreB,
    winner: scoreA === scoreB ? 'Tie' : (scoreA > scoreB ? a : b),
    exportedAt: id, players,
  };
}

describe('aggregateTournament', () => {
  it('accumulates W/L/T and points-for/against across games', () => {
    const games = [
      game({ id: 'g1', a: 'X', b: 'Y', scoreA: 100, scoreB: 80 }),
      game({ id: 'g2', a: 'X', b: 'Z', scoreA: 60,  scoreB: 90 }),
      game({ id: 'g3', a: 'Y', b: 'Z', scoreA: 70,  scoreB: 70 }),
    ];
    const agg = aggregateTournament(games);
    const byName = Object.fromEntries(agg.standings.map((t) => [t.name, t]));
    expect(byName['X']).toMatchObject({ wins: 1, losses: 1, ties: 0, pointsFor: 160, pointsAgainst: 170 });
    expect(byName['Y']).toMatchObject({ wins: 0, losses: 1, ties: 1, pointsFor: 150, pointsAgainst: 170 });
    expect(byName['Z']).toMatchObject({ wins: 1, losses: 0, ties: 1, pointsFor: 160, pointsAgainst: 130 });
  });

  it('sorts standings by wins, then point differential, then PF', () => {
    const games = [
      game({ id: 'g1', a: 'A', b: 'B', scoreA: 100, scoreB: 0 }),  // A blows out B
      game({ id: 'g2', a: 'C', b: 'B', scoreA: 60,  scoreB: 50 }), // C beats B narrowly
      game({ id: 'g3', a: 'A', b: 'C', scoreA: 0,   scoreB: 0 }),  // tie (both 0 wins from this)
    ];
    const agg = aggregateTournament(games);
    // A: 1W 0L 1T, diff +100. C: 1W 0L 1T, diff +10. B: 0W 2L, diff -110.
    expect(agg.standings.map((t) => t.name)).toEqual(['A', 'C', 'B']);
  });

  it('aggregates per-player points across games and reports best single game', () => {
    const games = [
      game({
        id: 'g1', a: 'X', b: 'Y', scoreA: 100, scoreB: 50,
        players: [
          { name: 'Alice', team: 'X', points: 60 },
          { name: 'Bob',   team: 'X', points: 40 },
          { name: 'Carla', team: 'Y', points: 50 },
        ],
      }),
      game({
        id: 'g2', a: 'X', b: 'Z', scoreA: 80, scoreB: 0,
        players: [
          { name: 'Alice', team: 'X', points: 50 },
          { name: 'Bob',   team: 'X', points: 30 },
        ],
      }),
    ];
    const agg = aggregateTournament(games);
    const alice = agg.leaderboard.find((p) => p.name === 'Alice');
    expect(alice).toMatchObject({ points: 110, gamesPlayed: 2, bestGame: 60 });
    expect(alice.ppg).toBe(55);
    // Sorted by ppg: Alice 55, Carla 50 (fewer total points than Bob), Bob 35.
    expect(agg.leaderboard.map((p) => p.name)).toEqual(['Alice', 'Carla', 'Bob']);
    expect(agg.summary.bestPlayerGame).toMatchObject({ name: 'Alice', points: 60 });
  });

  it('records the closest game and does not surface a blowout summary', () => {
    const games = [
      game({ id: 'close', a: 'A', b: 'B', scoreA: 51, scoreB: 50 }),
      game({ id: 'wide',  a: 'C', b: 'D', scoreA: 200, scoreB: 10 }),
      game({ id: 'mid',   a: 'A', b: 'D', scoreA: 80, scoreB: 60 }),
    ];
    const agg = aggregateTournament(games);
    expect(agg.summary.closestGame.id).toBe('close');
    expect(agg.summary.closestGame.margin).toBe(1);
    expect(agg.summary.biggestBlowout).toBeUndefined();
  });

  it('treats same-name players on different teams as separate', () => {
    const games = [
      game({
        id: 'g1', a: 'X', b: 'Y', scoreA: 50, scoreB: 50,
        players: [
          { name: 'Sam', team: 'X', points: 50 },
          { name: 'Sam', team: 'Y', points: 50 },
        ],
      }),
    ];
    const agg = aggregateTournament(games);
    const sams = agg.leaderboard.filter((p) => p.name === 'Sam');
    expect(sams).toHaveLength(2);
    expect(new Set(sams.map((p) => p.team))).toEqual(new Set(['X', 'Y']));
  });
});

describe('gamesForPlayer', () => {
  it('returns one row per game the player appeared in, augmented with their points + team result', () => {
    const games = [
      game({
        id: 'g1', a: 'X', b: 'Y', scoreA: 100, scoreB: 80,
        players: [
          { name: 'Alice', team: 'X', points: 60 },
          { name: 'Bob', team: 'X', points: 40 },
          { name: 'Carla', team: 'Y', points: 50 },
        ],
      }),
      game({
        id: 'g2', a: 'X', b: 'Z', scoreA: 60, scoreB: 90,
        players: [
          { name: 'Alice', team: 'X', points: 40 },
          { name: 'Bob', team: 'X', points: 20 },
          { name: 'Sam', team: 'Z', points: 90 },
        ],
      }),
    ];
    const aliceGames = gamesForPlayer(games, 'Alice', 'X');
    expect(aliceGames).toHaveLength(2);
    expect(aliceGames[0]).toMatchObject({ id: 'g1', points: 60, opponent: 'Y', teamScore: 100, opponentScore: 80, result: 'W' });
    expect(aliceGames[1]).toMatchObject({ id: 'g2', points: 40, opponent: 'Z', teamScore: 60, opponentScore: 90, result: 'L' });
  });

  it('does not return games where a same-named player on a different team played', () => {
    const games = [
      game({
        id: 'g1', a: 'X', b: 'Y', scoreA: 50, scoreB: 50,
        players: [
          { name: 'Sam', team: 'X', points: 30 },
          { name: 'Sam', team: 'Y', points: 30 },
        ],
      }),
    ];
    const xSam = gamesForPlayer(games, 'Sam', 'X');
    expect(xSam).toHaveLength(1);
    expect(xSam[0]).toMatchObject({ points: 30, teamScore: 50, opponent: 'Y' });
  });
});

describe('gamesForTeam', () => {
  it('filters and augments with opponent / result', () => {
    const games = [
      game({ id: 'g1', a: 'X', b: 'Y', scoreA: 100, scoreB: 80 }),
      game({ id: 'g2', a: 'X', b: 'Z', scoreA: 60,  scoreB: 90 }),
      game({ id: 'g3', a: 'Y', b: 'Z', scoreA: 70,  scoreB: 70 }),
    ];
    const xGames = gamesForTeam(games, 'X');
    expect(xGames.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(xGames[0]).toMatchObject({ opponent: 'Y', teamScore: 100, opponentScore: 80, result: 'W' });
    expect(xGames[1]).toMatchObject({ opponent: 'Z', teamScore: 60,  opponentScore: 90, result: 'L' });

    const yGames = gamesForTeam(games, 'Y');
    expect(yGames[1]).toMatchObject({ opponent: 'Z', teamScore: 70, opponentScore: 70, result: 'T' });
  });
});

describe('substitutions — fractional games played', () => {
  const games = [
    game({ id: 'g1', a: 'X', b: 'Y', scoreA: 100, scoreB: 80, players: [
      { name: 'Full', team: 'X', points: 60, played: 1 },
      { name: 'Half', team: 'X', points: 40, played: 0.5 },
      { name: 'Old', team: 'Y', points: 80 },                     // pre-column CSV: no `played`
    ] }),
    game({ id: 'g2', a: 'X', b: 'Y', scoreA: 50, scoreB: 90, players: [
      { name: 'Full', team: 'X', points: 30, played: 1 },
      { name: 'Half', team: 'X', points: 20, played: 0.25 },
      { name: 'Bench', team: 'X', points: 0, played: 0 },         // rostered, never played
      { name: 'Old', team: 'Y', points: 90 },
    ] }),
  ];

  it('sums Played into gamesPlayed (1 when absent) and rates PPG per full game', () => {
    const agg = aggregateTournament(games);
    const by = Object.fromEntries(agg.leaderboard.map((p) => [p.name, p]));
    expect(by['Full']).toMatchObject({ points: 90, gamesPlayed: 2, appearances: 2, ppg: 45 });
    expect(by['Half']).toMatchObject({ points: 60, gamesPlayed: 0.75, appearances: 2, ppg: 80 });
    expect(by['Old']).toMatchObject({ points: 170, gamesPlayed: 2, appearances: 2, ppg: 85 });
    expect(by['Bench']).toMatchObject({ points: 0, gamesPlayed: 0, appearances: 1, ppg: 0 });
  });

  it('gamesForPlayer carries each game\'s played fraction', () => {
    expect(gamesForPlayer(games, 'Half', 'X').map((g) => g.played)).toEqual([0.5, 0.25]);
    expect(gamesForPlayer(games, 'Old', 'Y').map((g) => g.played)).toEqual([1, 1]);
  });

  it('team standings are untouched by substitutions', () => {
    const agg = aggregateTournament(games);
    const x = agg.standings.find((t) => t.name === 'X');
    expect(x).toMatchObject({ wins: 1, losses: 1, gamesPlayed: 2 });
  });
});
