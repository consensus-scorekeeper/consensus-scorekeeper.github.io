// Presentation-style scoreboard rendered in a separate window so the
// moderator can show scores + current-question context to players (e.g.,
// on a projector / second monitor). The main window broadcasts state via
// BroadcastChannel; the popout listens and re-renders.

import { state } from '../state.js';
import { getSplitPair, getCategoryRunSize, getAnsweredBy } from '../game/categories.js';
import { isBenched } from '../util/participation.js';

const SCOREBOARD_CHANNEL = 'consensus-scoreboard';
const scoreboardChannel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel(SCOREBOARD_CHANNEL) : null;
if (scoreboardChannel) {
  scoreboardChannel.onmessage = (e) => {
    if (e.data && e.data.type === 'request-state') pushScoreboardUpdate();
  };
}

// Build the live state snapshot shown to players: rendered by the popout
// window (BroadcastChannel) AND pushed to phone-buzzer rooms as the
// {t:'state'} payload (src/ui/room.js). One builder, two transports —
// anything added here shows up on both. Never include information the
// players shouldn't see (streak positions stay hidden, see below).
export function getScoreboardSnapshot() {
  const q = state.questions[state.currentQuestion] || {};
  let posNum = null, posTotal = null;
  // Streaks intentionally show no position counter — revealing "1 of 3"
  // would tell the players exactly how many more parts the streak has.
  if (!q.isStreak && q.posInCategory) {
    posNum = q.posInCategory;
    if (q.category) {
      posTotal = getCategoryRunSize(state.currentQuestion, q.category, q.posInCategory);
    }
  }
  const splitPair = getSplitPair(state.currentQuestion, q.category);
  const isJailbreak = !!(q.category && /jailbreak/i.test(q.category));
  // benched: currently subbed out (displays muted; their phone can't buzz).
  const players = (team) => team.players.map(p => ({ name: p.name, points: p.points, benched: isBenched(p) }));
  return {
    type: 'state',
    teamA: {
      name: state.teamA.name,
      score: state.teamA.score,
      players: players(state.teamA),
    },
    teamB: {
      name: state.teamB.name,
      score: state.teamB.score,
      players: players(state.teamB),
    },
    qNum: q.num || (state.currentQuestion + 1),
    qTotal: state.questions.length || 100,
    category: q.category || null,
    posNum, posTotal,
    packName: state.packName || null,
    splitPair, // { current, partner, currentNum } or null
    jailbreak: isJailbreak ? {
      lockedA: [...state.jailbreakLocked.a],
      lockedB: [...state.jailbreakLocked.b],
    } : null,
    answered: getAnsweredBy(state.currentQuestion),
  };
}

export function pushScoreboardUpdate() {
  if (!scoreboardChannel) return;
  try { scoreboardChannel.postMessage(getScoreboardSnapshot()); } catch (e) { /* ignore */ }
}

// HTML written into the popout window. Self-contained: own <style> and
// <script> that subscribe to the same BroadcastChannel.
const SCOREBOARD_POPOUT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Consensus Scoreboard</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f0f10;
    color: #fff;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
  }
  .pack { font-size: 1rem; color: #777; margin-bottom: 18px; letter-spacing: 0.04em; }
  .scores {
    display: flex;
    align-items: center;
    gap: 8vw;
    margin-bottom: 6vh;
  }
  .team { display: flex; flex-direction: column; align-items: center; }
  .team-name {
    font-size: clamp(1.4rem, 3vw, 2.6rem);
    font-weight: 600;
    margin-bottom: 0.4em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .team.a .team-name { color: #5b9eff; }
  .team.b .team-name { color: #ff7a7a; }
  .team-score {
    font-size: clamp(5rem, 14vw, 12rem);
    font-weight: 800;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .divider { font-size: clamp(4rem, 10vw, 8rem); color: #444; font-weight: 800; }
  .info {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .qline {
    font-size: clamp(1.2rem, 2.4vw, 2rem);
    font-weight: 600;
    color: #ddd;
  }
  .qline .num { color: #fff; font-variant-numeric: tabular-nums; }
  .catline {
    font-size: clamp(1rem, 1.8vw, 1.5rem);
    color: #aaa;
  }
  .catline .pos { color: #888; margin-left: 8px; font-variant-numeric: tabular-nums; }
  /* Splits view: both sub-categories shown side by side, current one highlighted. */
  .splitline {
    font-size: clamp(1rem, 1.8vw, 1.5rem);
    color: #777;
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .splitline .label { color: #555; font-weight: 600; }
  .splitline .opt { padding: 4px 10px; border-radius: 6px; }
  .splitline .opt.current { color: #fff; background: #2563eb; font-weight: 600; }
  .splitline .opt.other { color: #888; }
  .splitline .vs { color: #444; font-size: 0.8em; }
  /* Jailbreak: both rosters shown so the players know who's available to buzz. */
  .rosters {
    display: none;
    gap: clamp(2rem, 6vw, 5rem);
    margin-top: 4vh;
    align-items: flex-start;
  }
  .roster {
    flex: 1;
    max-width: 320px;
    text-align: left;
  }
  .roster .roster-name {
    font-size: clamp(1rem, 1.6vw, 1.4rem);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 12px;
    text-align: center;
  }
  .roster.a .roster-name { color: #5b9eff; }
  .roster.b .roster-name { color: #ff7a7a; }
  .roster ul { list-style: none; padding: 0; margin: 0; }
  .roster li {
    font-size: clamp(1.1rem, 1.8vw, 1.6rem);
    padding: 6px 12px;
    border-radius: 6px;
    margin-bottom: 4px;
    background: #1c1c1f;
  }
  .roster li.locked {
    opacity: 0.35;
    text-decoration: line-through;
    background: #161617;
  }
  .roster li.benched { opacity: 0.3; font-style: italic; background: #161617; }
  .roster li.benched::after { content: " (sub)"; font-size: 0.7em; color: #888; }
</style>
</head>
<body>
  <div class="pack" id="pack"></div>
  <div class="scores">
    <div class="team a">
      <div class="team-name" id="ta-name">Team A</div>
      <div class="team-score" id="ta-score">0</div>
    </div>
    <div class="divider">:</div>
    <div class="team b">
      <div class="team-name" id="tb-name">Team B</div>
      <div class="team-score" id="tb-score">0</div>
    </div>
  </div>
  <div class="info">
    <div class="qline">Question <span class="num" id="qnum">—</span> / <span class="num" id="qtotal">100</span></div>
    <div class="catline" id="catline"><span id="category"></span><span class="pos" id="pos"></span></div>
    <div class="splitline" id="splitline" style="display:none">
      <span class="label">Splits:</span>
      <span class="opt" id="split-1"></span>
      <span class="vs">vs</span>
      <span class="opt" id="split-2"></span>
      <span class="pos" id="split-pos"></span>
    </div>
  </div>
  <div class="rosters" id="rosters">
    <div class="roster a">
      <div class="roster-name" id="ra-name">Team A</div>
      <ul id="ra-list"></ul>
    </div>
    <div class="roster b">
      <div class="roster-name" id="rb-name">Team B</div>
      <ul id="rb-list"></ul>
    </div>
  </div>
<script>
(() => {
  const ch = new BroadcastChannel('consensus-scoreboard');
  function $(id) { return document.getElementById(id); }
  function bareSplitTitle(c) {
    return (c || '').replace(/^Splits \\d+:\\s*/, '').trim();
  }
  function update(d) {
    if (!d) return;
    $('ta-name').textContent = d.teamA.name;
    $('ta-score').textContent = d.teamA.score;
    $('tb-name').textContent = d.teamB.name;
    $('tb-score').textContent = d.teamB.score;
    $('qnum').textContent = d.qNum;
    $('qtotal').textContent = d.qTotal;
    $('pack').textContent = d.packName || '';
    document.title = (d.teamA.name + ' ' + d.teamA.score + ' \\u2014 ' + d.teamB.score + ' ' + d.teamB.name);

    // Splits view shows both sub-categories with the current one highlighted.
    if (d.splitPair) {
      const cur = bareSplitTitle(d.splitPair.current);
      const other = bareSplitTitle(d.splitPair.partner);
      const opt1 = $('split-1'), opt2 = $('split-2');
      const isFirst = d.splitPair.currentNum === 1;
      opt1.textContent = isFirst ? cur : other;
      opt2.textContent = isFirst ? other : cur;
      opt1.className = 'opt ' + (isFirst ? 'current' : 'other');
      opt2.className = 'opt ' + (isFirst ? 'other' : 'current');
      $('split-pos').textContent = (d.posNum && d.posTotal) ? '(' + d.posNum + ' / ' + d.posTotal + ')' : '';
      $('catline').style.display = 'none';
      $('splitline').style.display = 'flex';
    } else {
      $('category').textContent = d.category || '';
      $('pos').textContent = (d.posNum && d.posTotal) ? '(' + d.posNum + ' / ' + d.posTotal + ')' : '';
      $('catline').style.display = '';
      $('splitline').style.display = 'none';
    }

    // Jailbreak rosters: show both team rosters with locked players muted.
    if (d.jailbreak) {
      $('ra-name').textContent = d.teamA.name;
      $('rb-name').textContent = d.teamB.name;
      const buildRoster = (players, locked) => players.map((p, i) => {
        const cls = p.benched ? 'benched' : (locked.indexOf(i) !== -1 ? 'locked' : '');
        const safe = String(p.name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return '<li class="' + cls + '">' + safe + '</li>';
      }).join('');
      $('ra-list').innerHTML = buildRoster(d.teamA.players || [], d.jailbreak.lockedA || []);
      $('rb-list').innerHTML = buildRoster(d.teamB.players || [], d.jailbreak.lockedB || []);
      $('rosters').style.display = 'flex';
    } else {
      $('rosters').style.display = 'none';
    }
  }
  ch.onmessage = (e) => { if (e.data && e.data.type === 'state') update(e.data); };
  // Ask the main window for current state.
  ch.postMessage({ type: 'request-state' });
})();
<\/script>
</body>
</html>`;

export function popOutScoreboard() {
  const w = window.open('', 'consensus-scoreboard-popout', 'width=900,height=560,resizable=yes');
  if (!w) {
    alert('Popup blocked. Allow popups for this site to use the scoreboard popout.');
    return;
  }
  w.document.open();
  w.document.write(SCOREBOARD_POPOUT_HTML);
  w.document.close();
  // Push current state immediately too — the popout's request-state on load
  // also asks, but if it's an existing window getting reused this guarantees
  // a refresh.
  pushScoreboardUpdate();
}
