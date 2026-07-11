// Tournament Stats viewer. Powers the per-tournament stats page (e.g.
// tournaments/stanford-consensus-2026/index.html). The DOM contract is:
//   - <span id="ts-status">                  ← optional load status line
//   - <div id="ts-content">                  ← rendered into
//   - everything wrapped in #tournament-stats-section so the delegated
//     click handler has a stable parent
//
// CSVs are loaded exclusively from the manifest passed in via
// setupTournamentStats({ manifestUrl }). User-uploaded CSVs are no longer
// supported on the public page — published data is the only source.
// Manifest shape: { "games": [filename, ...] } (or a bare array).
//
// Views (tsState.view):
//   - 'standings' — team table + individual leaderboard + summary
//   - 'team'      — one team's record + all their games
//   - 'player'    — one player's per-game points across all their games
//   - 'game'      — full per-player breakdown of a single match

import { parseResultsCsv } from '../util/parse-results-csv.js';
import { aggregateTournament, gamesForTeam, gamesForPlayer } from '../util/tournament-aggregate.js';
import { escapeHtml } from '../util/escape.js';
import {
  pullsForIssueUrl,
  classifyPull,
  pullFilesUrl,
  previewCsvFiles,
  rawFileUrl,
  previewBannerText,
} from '../util/submission-preview.js';

const tsState = {
  games: [],                      // [{ id, packet, teamA, teamB, scoreA, scoreB, winner, exportedAt, players }]
  view: 'standings',              // 'standings' | 'team' | 'player' | 'game'
  selectedTeam: null,             // team name (string) when view === 'team' | 'player'
  selectedPlayer: null,           // player name (string) when view === 'player'
  selectedGameId: null,           // game id (string) when view === 'game'
  loading: false,                 // true while loadFromManifest is in flight
};

function setStatus(msg, kind) {
  const el = document.getElementById('ts-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'ts-status' + (kind ? ` ts-status-${kind}` : '');
}

function upsertGame(game) {
  const i = tsState.games.findIndex((g) => g.id === game.id);
  if (i >= 0) tsState.games[i] = game;
  else tsState.games.push(game);
}

// Fetch the manifest, then each listed CSV. Each refresh replaces the
// full game list so a redeploy reflects the latest set. Tolerates missing
// manifest / missing files; the page just renders empty.
//
// The `finally` clause clears the loading flag and re-renders unconditionally
// so the spinner doesn't get stuck on the screen if the fetch fails, the
// manifest is empty, or every CSV inside is malformed.
async function loadFromManifest(manifestUrl) {
  try {
    const resp = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!resp.ok) return;
    const data = await resp.json();
    const list = Array.isArray(data) ? data : (data.games || []);
    if (!list.length) return;

    // Resolve CSV paths relative to the manifest's directory.
    const baseUrl = new URL(manifestUrl, document.baseURI);
    const baseDir = baseUrl.href.replace(/[^/]+$/, '');

    // Parallel CSV fetches — large tournaments have 50+ games, and waiting
    // for each fetch in series turns load time into 50× round-trip time.
    // Default cache policy is fine for the CSV bodies: filenames are
    // content-addressed (they include the export timestamp), so the browser
    // can cache them indefinitely — only the manifest itself is mutable and
    // keeps its `cache: 'no-cache'` above.
    const filenames = list
      .map((e) => (typeof e === 'string' ? e : e.filename))
      .filter(Boolean);

    const results = await Promise.all(filenames.map(async (filename) => {
      try {
        const csvResp = await fetch(baseDir + encodeURIComponent(filename));
        if (!csvResp.ok) return { ok: false, filename };
        const text = await csvResp.text();
        const parsed = parseResultsCsv(text);
        if (!parsed.teamA || !parsed.teamB) return { ok: false, filename };
        return { ok: true, filename, parsed };
      } catch {
        return { ok: false, filename };
      }
    }));

    tsState.games = [];
    let added = 0, failed = 0;
    for (const r of results) {
      if (r.ok) {
        upsertGame({ id: r.filename, ...r.parsed });
        added++;
      } else {
        failed++;
      }
    }
    if (added) {
      setStatus(
        `Loaded ${added} game${added === 1 ? '' : 's'}` + (failed ? ` (${failed} failed)` : '') + '.',
        failed ? 'warn' : 'ok',
      );
    }
  } catch (e) {
    console.warn('[tournament-stats] failed to load manifest:', e);
  } finally {
    tsState.loading = false;
    render();
  }
}

// ==================== PENDING-SUBMISSION PREVIEW ====================

// Persistent banner above the status line while previewing an unmerged
// submission. Lives outside #ts-content so view navigation can't wipe it.
function setPreviewBanner(text, kind) {
  const section = document.getElementById('tournament-stats-section');
  if (!section) return;
  let el = document.getElementById('ts-preview-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ts-preview-banner';
    section.insertBefore(el, section.firstChild);
  }
  el.className = `ts-preview-banner ts-preview-${kind}`;
  el.textContent = text;
}

// Overlays the games from an unmerged submission PR (submission/issue-<N>)
// onto the published set: resolve the branch's PR, list its changed files,
// fetch each of this tournament's CSVs from the PR's head commit, and
// upsert by filename — the same content-identity the pipeline uses, so a
// correction previews as a replacement rather than a duplicate game.
// Purely client-side: the GitHub REST API and raw.githubusercontent.com
// both allow cross-origin reads on public repos.
async function loadPreview({ issue, slug }) {
  setPreviewBanner(`Loading pending submission #${issue}…`, 'loading');
  const fetchJson = async (url) => {
    const resp = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (!resp.ok) throw new Error(`${resp.status} for ${url}`);
    return resp.json();
  };
  try {
    const { status, pull } = classifyPull(await fetchJson(pullsForIssueUrl(issue)));
    if (status !== 'open') {
      setPreviewBanner(previewBannerText({ status, issue }), status === 'merged' ? 'ok' : 'info');
      return;
    }

    // A bulk drop can exceed one page of changed files; follow up to a
    // sane number of extra pages rather than silently truncating.
    const files = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await fetchJson(pullFilesUrl(pull.number, page));
      files.push(...batch);
      if (batch.length < 100) break;
    }

    const csvs = previewCsvFiles(files, slug);
    const results = await Promise.all(csvs.map(async (f) => {
      try {
        const resp = await fetch(rawFileUrl(pull.head.sha, f.path));
        if (!resp.ok) return { ok: false };
        const parsed = parseResultsCsv(await resp.text());
        if (!parsed.teamA || !parsed.teamB) return { ok: false };
        return { ok: true, filename: f.filename, parsed };
      } catch {
        return { ok: false };
      }
    }));

    let loaded = 0, replaced = 0, failed = 0;
    for (const r of results) {
      if (!r.ok) { failed++; continue; }
      if (tsState.games.some((g) => g.id === r.filename)) replaced++;
      upsertGame({ id: r.filename, ...r.parsed });
      loaded++;
    }
    setPreviewBanner(previewBannerText({ status: 'open', issue, loaded, replaced, failed }), 'warn');
  } catch (e) {
    console.warn('[tournament-stats] failed to load submission preview:', e);
    setPreviewBanner(previewBannerText({ status: 'error', issue }), 'error');
  } finally {
    render();
  }
}

function resetView() {
  tsState.view = 'standings';
  tsState.selectedTeam = null;
  tsState.selectedPlayer = null;
  tsState.selectedGameId = null;
}

function showStandings() {
  resetView();
  render();
}

function showTeam(name) {
  tsState.view = 'team';
  tsState.selectedTeam = name;
  tsState.selectedPlayer = null;
  tsState.selectedGameId = null;
  render();
}

function showPlayer(team, name) {
  tsState.view = 'player';
  tsState.selectedTeam = team;
  tsState.selectedPlayer = name;
  tsState.selectedGameId = null;
  render();
}

function showGame(id) {
  tsState.view = 'game';
  tsState.selectedGameId = id;
  render();
}

// ==================== RENDER ====================

function pct(n, d) {
  if (!d) return '—';
  return `${((n / d) * 100).toFixed(0)}%`;
}

function renderStandings(agg) {
  const sRows = agg.standings.map((t) => `
    <tr class="ts-row-clickable" data-action="ts-show-team" data-team="${escapeHtml(t.name)}">
      <td>${escapeHtml(t.name)}</td>
      <td>${t.wins}</td>
      <td>${t.losses}</td>
      <td>${t.ties}</td>
      <td>${pct(t.wins + 0.5 * t.ties, t.gamesPlayed)}</td>
      <td>${t.pointsFor}</td>
      <td>${t.pointsAgainst}</td>
      <td>${t.pointsFor - t.pointsAgainst >= 0 ? '+' : ''}${t.pointsFor - t.pointsAgainst}</td>
    </tr>`).join('');

  const lRows = agg.leaderboard.map((p, i) => `
    <tr class="ts-row-clickable" data-action="ts-show-player" data-team="${escapeHtml(p.team)}" data-player="${escapeHtml(p.name)}">
      <td>${i + 1}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.team)}</td>
      <td>${p.points}</td>
      <td>${p.gamesPlayed}</td>
      <td>${p.ppg.toFixed(1)}</td>
      <td>${p.bestGame}</td>
    </tr>`).join('');

  const s = agg.summary;
  const summaryHtml = `
    <div class="ts-summary">
      <div><strong>${s.totalGames}</strong> game${s.totalGames === 1 ? '' : 's'}</div>
      ${s.closestGame ? `<div>Closest: <strong>${escapeHtml(s.closestGame.teamA)} ${s.closestGame.scoreA} – ${s.closestGame.scoreB} ${escapeHtml(s.closestGame.teamB)}</strong> (margin ${s.closestGame.margin})</div>` : ''}
      ${s.bestPlayerGame ? `<div>Top single-game: <strong>${escapeHtml(s.bestPlayerGame.name)}</strong> (${escapeHtml(s.bestPlayerGame.team)}) — ${s.bestPlayerGame.points} pts</div>` : ''}
    </div>`;

  return `
    ${summaryHtml}
    <div class="ts-stack">
      <div class="ts-panel">
        <h3>Team Standings</h3>
        <table class="ts-table">
          <thead><tr><th>Team</th><th>W</th><th>L</th><th>T</th><th>%</th><th>PF</th><th>PA</th><th>±</th></tr></thead>
          <tbody>${sRows}</tbody>
        </table>
        <div class="ts-hint">Click a team to see their games.</div>
      </div>
      <div class="ts-panel">
        <h3>Individual Leaderboard</h3>
        <table class="ts-table">
          <thead><tr><th>#</th><th>Player</th><th>Team</th><th>Pts</th><th>GP</th><th>PPG</th><th>Best</th></tr></thead>
          <tbody>${lRows}</tbody>
        </table>
        <div class="ts-hint">Click a player to see their per-game performances.</div>
      </div>
    </div>`;
}

function renderTeamView(agg) {
  const teamName = tsState.selectedTeam;
  const team = agg.standings.find((t) => t.name === teamName);
  if (!team) return `<div class="ts-empty">Team not found.</div>`;

  const teamGames = gamesForTeam(tsState.games, teamName);
  teamGames.sort((x, y) => String(x.exportedAt).localeCompare(String(y.exportedAt)));

  const rows = teamGames.map((g) => `
    <tr class="ts-row-clickable ts-result-${g.result}" data-action="ts-show-game" data-game-id="${escapeHtml(g.id)}">
      <td>${escapeHtml(g.packet || '—')}</td>
      <td>${escapeHtml(g.opponent)}</td>
      <td><strong>${g.teamScore}</strong> – ${g.opponentScore}</td>
      <td>${g.result}</td>
    </tr>`).join('');

  const teamPlayers = agg.leaderboard.filter((p) => p.team === teamName);
  const playerRows = teamPlayers.map((p) => `
    <tr class="ts-row-clickable" data-action="ts-show-player" data-team="${escapeHtml(p.team)}" data-player="${escapeHtml(p.name)}">
      <td>${escapeHtml(p.name)}</td>
      <td>${p.points}</td>
      <td>${p.gamesPlayed}</td>
      <td>${p.ppg.toFixed(1)}</td>
      <td>${p.bestGame}</td>
    </tr>`).join('');

  return `
    <div class="ts-breadcrumbs">
      <a data-action="ts-show-standings">← All standings</a>
    </div>
    <h3>${escapeHtml(teamName)}</h3>
    <div class="ts-team-meta">
      <span><strong>${team.wins}</strong>W – <strong>${team.losses}</strong>L${team.ties ? ` – <strong>${team.ties}</strong>T` : ''}</span>
      <span>PF ${team.pointsFor} · PA ${team.pointsAgainst} · ± ${team.pointsFor - team.pointsAgainst >= 0 ? '+' : ''}${team.pointsFor - team.pointsAgainst}</span>
    </div>
    <div class="ts-grid">
      <div class="ts-panel">
        <h3>Games</h3>
        <table class="ts-table">
          <thead><tr><th>Packet</th><th>Opponent</th><th>Score</th><th>Result</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="ts-hint">Click a game for the per-player breakdown.</div>
      </div>
      <div class="ts-panel">
        <h3>Player Totals</h3>
        <table class="ts-table">
          <thead><tr><th>Player</th><th>Pts</th><th>GP</th><th>PPG</th><th>Best</th></tr></thead>
          <tbody>${playerRows}</tbody>
        </table>
        <div class="ts-hint">Click a player to drill in.</div>
      </div>
    </div>`;
}

function renderPlayerView(agg) {
  const playerName = tsState.selectedPlayer;
  const teamName = tsState.selectedTeam;
  const player = agg.leaderboard.find((p) => p.name === playerName && p.team === teamName);
  if (!player) return `<div class="ts-empty">Player not found.</div>`;

  const games = gamesForPlayer(tsState.games, playerName, teamName);
  games.sort((x, y) => String(x.exportedAt).localeCompare(String(y.exportedAt)));

  const rows = games.map((g) => `
    <tr class="ts-row-clickable ts-result-${g.result}" data-action="ts-show-game" data-game-id="${escapeHtml(g.id)}">
      <td>${escapeHtml(g.packet || '—')}</td>
      <td>${escapeHtml(g.opponent)}</td>
      <td><strong>${g.points}</strong></td>
      <td>${g.teamScore} – ${g.opponentScore}</td>
      <td>${g.result}</td>
    </tr>`).join('');

  // Quick descriptive stats: high, low, std-dev approximation.
  const pts = games.map((g) => g.points);
  const high = pts.length ? Math.max(...pts) : 0;
  const low = pts.length ? Math.min(...pts) : 0;

  return `
    <div class="ts-breadcrumbs">
      <a data-action="ts-show-standings">← All standings</a>
      · <a data-action="ts-show-team" data-team="${escapeHtml(teamName)}">${escapeHtml(teamName)}</a>
    </div>
    <h3>${escapeHtml(playerName)} <span class="ts-team-meta-inline">${escapeHtml(teamName)}</span></h3>
    <div class="ts-team-meta">
      <span>Total <strong>${player.points}</strong> pts</span>
      <span>${player.gamesPlayed} GP</span>
      <span>PPG <strong>${player.ppg.toFixed(1)}</strong></span>
      <span>High ${high} · Low ${low}</span>
    </div>
    <div class="ts-panel">
      <h3>Per-Game Performances</h3>
      <table class="ts-table">
        <thead><tr><th>Packet</th><th>Opponent</th><th>Pts</th><th>Team Score</th><th>Result</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="ts-hint">Click a row to see the full game breakdown.</div>
    </div>`;
}

function renderGameView() {
  const game = tsState.games.find((g) => g.id === tsState.selectedGameId);
  if (!game) return `<div class="ts-empty">Game not found.</div>`;
  const winner = game.scoreA > game.scoreB ? game.teamA
                : game.scoreB > game.scoreA ? game.teamB
                : 'Tie';
  const playersOf = (team) => game.players
    .filter((p) => p.team === team)
    .sort((x, y) => y.points - x.points);
  const tableFor = (team, score) => {
    const rows = playersOf(team).map((p) =>
      `<tr class="ts-row-clickable" data-action="ts-show-player" data-team="${escapeHtml(team)}" data-player="${escapeHtml(p.name)}"><td>${escapeHtml(p.name)}</td><td>${p.points}</td></tr>`).join('');
    return `
      <div class="ts-panel">
        <h3>${escapeHtml(team)} <span class="ts-team-score">${score}</span></h3>
        <table class="ts-table">
          <thead><tr><th>Player</th><th>Points</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  };
  // Build breadcrumbs back to whatever the user came from.
  const crumbs = ['<a data-action="ts-show-standings">← All standings</a>'];
  if (tsState.selectedTeam) {
    crumbs.push(`<a data-action="ts-show-team" data-team="${escapeHtml(tsState.selectedTeam)}">${escapeHtml(tsState.selectedTeam)}</a>`);
  }
  if (tsState.selectedPlayer) {
    crumbs.push(`<a data-action="ts-show-player" data-team="${escapeHtml(tsState.selectedTeam)}" data-player="${escapeHtml(tsState.selectedPlayer)}">${escapeHtml(tsState.selectedPlayer)}</a>`);
  }
  return `
    <div class="ts-breadcrumbs">${crumbs.join(' · ')}</div>
    <h3>${escapeHtml(game.packet || 'Game')}</h3>
    <div class="ts-team-meta">
      <span><strong>${escapeHtml(game.teamA)} ${game.scoreA}</strong> – <strong>${game.scoreB} ${escapeHtml(game.teamB)}</strong></span>
      <span>Winner: ${winner === 'Tie' ? 'Tie' : `<strong>${escapeHtml(winner)}</strong>`}</span>
    </div>
    <div class="ts-grid">
      ${tableFor(game.teamA, game.scoreA)}
      ${tableFor(game.teamB, game.scoreB)}
    </div>`;
}

function render() {
  const content = document.getElementById('ts-content');
  if (!content) return;
  if (tsState.loading) {
    content.innerHTML = `<div class="ts-loading"><span class="ts-spinner" aria-hidden="true"></span> Loading games…</div>`;
    return;
  }
  if (!tsState.games.length) {
    content.innerHTML = `<div class="ts-empty">No games published yet.</div>`;
    return;
  }
  const agg = aggregateTournament(tsState.games);
  if (tsState.view === 'team')        content.innerHTML = renderTeamView(agg);
  else if (tsState.view === 'player') content.innerHTML = renderPlayerView(agg);
  else if (tsState.view === 'game')   content.innerHTML = renderGameView();
  else                                content.innerHTML = renderStandings(agg);
}

// preview (optional): { issue, slug } — overlay the games from that
// issue's unmerged submission PR after the published manifest loads.
export function setupTournamentStats({ manifestUrl, preview } = {}) {
  // Delegated click handler for the in-page navigation (drill into team /
  // player / game views). Bound to a stable section parent so it survives
  // re-renders of #ts-content.
  const section = document.getElementById('tournament-stats-section');
  if (section) {
    section.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if      (action === 'ts-show-standings') showStandings();
      else if (action === 'ts-show-team')      showTeam(target.dataset.team);
      else if (action === 'ts-show-player')    showPlayer(target.dataset.team, target.dataset.player);
      else if (action === 'ts-show-game')      showGame(target.dataset.gameId);
    });
  }
  // If a manifest is configured, paint the loading state BEFORE the fetch
  // kicks off so the user never sees the "no games published" flash.
  if (manifestUrl) tsState.loading = true;
  render();
  // Preview waits for the published games so the overlay's replace-vs-add
  // accounting (and the final render) sees the complete picture. A missing
  // manifest (brand-new tournament) resolves to an empty set and the
  // preview still loads.
  (async () => {
    if (manifestUrl) await loadFromManifest(manifestUrl);
    if (preview && preview.issue && preview.slug) await loadPreview(preview);
  })();
}
