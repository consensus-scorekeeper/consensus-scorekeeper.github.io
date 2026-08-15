// Roll a list of parsed game results (from parseResultsCsv) into the shape
// the Tournament Stats UI wants to render: team standings (W/L/T + points
// for/against), individual leaderboard, plus tournament-wide highlights
// (closest game, biggest blowout, single-game player record).
//
// Each input game gets an `id` injected by the caller (we use the upload
// filename) so the UI can navigate to a specific game by id. This module
// preserves that id on the games it returns.
//
// Pure — no DOM, no IO. Tests in tests/tournament-aggregate.test.js.

function blankTeam(name) {
  return { name, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, gamesPlayed: 0 };
}

function blankPlayer(name, team) {
  return { name, team, points: 0, gamesPlayed: 0, bestGame: 0 };
}

export function aggregateTournament(games) {
  const teams = new Map();      // teamName -> stats
  const players = new Map();    // `${team}::${player}` -> stats

  let closestGame = null;       // { id, margin, ... }
  let bestPlayerGame = null;    // { id, name, team, points, ... }

  for (const g of games) {
    const { id, teamA, teamB, scoreA, scoreB } = g;

    if (!teams.has(teamA)) teams.set(teamA, blankTeam(teamA));
    if (!teams.has(teamB)) teams.set(teamB, blankTeam(teamB));

    const a = teams.get(teamA);
    const b = teams.get(teamB);
    a.gamesPlayed++; b.gamesPlayed++;
    a.pointsFor += scoreA; a.pointsAgainst += scoreB;
    b.pointsFor += scoreB; b.pointsAgainst += scoreA;

    if (scoreA > scoreB)      { a.wins++;   b.losses++; }
    else if (scoreB > scoreA) { b.wins++;   a.losses++; }
    else                      { a.ties++;   b.ties++; }

    const margin = Math.abs(scoreA - scoreB);
    if (closestGame === null || margin < closestGame.margin) {
      closestGame = { id, teamA, teamB, scoreA, scoreB, margin };
    }

    for (const p of g.players || []) {
      const key = `${p.team}::${p.name}`;
      if (!players.has(key)) players.set(key, blankPlayer(p.name, p.team));
      const ps = players.get(key);
      ps.points += p.points;
      ps.gamesPlayed++;
      if (p.points > ps.bestGame) ps.bestGame = p.points;
      if (bestPlayerGame === null || p.points > bestPlayerGame.points) {
        bestPlayerGame = { id, name: p.name, team: p.team, points: p.points };
      }
    }
  }

  // Standings sort: wins desc, then point differential desc, then PF desc,
  // then name asc to keep output stable.
  const standings = Array.from(teams.values()).sort((x, y) => {
    if (y.wins !== x.wins) return y.wins - x.wins;
    const xd = x.pointsFor - x.pointsAgainst;
    const yd = y.pointsFor - y.pointsAgainst;
    if (yd !== xd) return yd - xd;
    if (y.pointsFor !== x.pointsFor) return y.pointsFor - x.pointsFor;
    return x.name.localeCompare(y.name);
  });

  // Player leaderboard sort: ppg desc, then total points desc, then name.
  const leaderboard = Array.from(players.values()).map((p) => ({
    ...p,
    ppg: p.gamesPlayed ? p.points / p.gamesPlayed : 0,
  })).sort((x, y) => {
    if (y.ppg !== x.ppg) return y.ppg - x.ppg;
    if (y.points !== x.points) return y.points - x.points;
    return x.name.localeCompare(y.name);
  });

  return {
    standings,
    leaderboard,
    games,
    summary: {
      totalGames: games.length,
      closestGame,
      bestPlayerGame,
    },
  };
}

// Filter games to those involving `teamName`, returning each augmented with
// `opponent`, `teamScore`, `opponentScore`, `result` ('W'|'L'|'T') for the UI.
export function gamesForTeam(games, teamName) {
  const out = [];
  for (const g of games) {
    let teamScore, opponent, opponentScore;
    if (g.teamA === teamName)      { teamScore = g.scoreA; opponent = g.teamB; opponentScore = g.scoreB; }
    else if (g.teamB === teamName) { teamScore = g.scoreB; opponent = g.teamA; opponentScore = g.scoreA; }
    else continue;
    const result = teamScore > opponentScore ? 'W' : teamScore < opponentScore ? 'L' : 'T';
    out.push({ ...g, opponent, teamScore, opponentScore, result });
  }
  return out;
}

// Filter games to those where `playerName` on `teamName` appeared, augmented
// with `points` (this player's contribution that game), `opponent`, the team
// scores, and the team result. Drives the per-player drill-down view.
export function gamesForPlayer(games, playerName, teamName) {
  const out = [];
  for (const g of games) {
    const player = (g.players || []).find((p) => p.name === playerName && p.team === teamName);
    if (!player) continue;
    const teamScore = g.teamA === teamName ? g.scoreA : g.scoreB;
    const opponent = g.teamA === teamName ? g.teamB : g.teamA;
    const opponentScore = g.teamA === teamName ? g.scoreB : g.scoreA;
    const result = teamScore > opponentScore ? 'W' : teamScore < opponentScore ? 'L' : 'T';
    out.push({ ...g, points: player.points, opponent, teamScore, opponentScore, result });
  }
  return out;
}
