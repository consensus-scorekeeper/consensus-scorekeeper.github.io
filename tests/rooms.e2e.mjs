// Live E2E for the phone-buzzer rooms: exercises the VENDORED client
// (src/vendor/room.js) against the deployed shared room server with a
// consensus-shaped snapshot/qlog, plus a spectator-sentinel join.
// Needs node >= 22 (global WebSocket + fetch); hits the live instance,
// so it is NOT part of CI / vitest. Run: node tests/rooms.e2e.mjs [server-url]

import { DEFAULT_SERVER, createRoom, connectHost } from '../src/vendor/room.js';

const SERVER = process.argv[2] || DEFAULT_SERVER;
const WS = SERVER.replace('http', 'ws');

const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
const ok = (msg) => console.log('  ok ', msg);
const wait = (pred, why, ms = 5000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const timer = setInterval(() => {
    const v = pred();
    if (v) { clearInterval(timer); resolve(v); }
    else if (Date.now() - t0 > ms) { clearInterval(timer); reject(new Error('timeout: ' + why)); }
  }, 25);
});

function connectPlayer(code, name) {
  const ws = new WebSocket(`${WS}/rooms/${code}/ws?name=${encodeURIComponent(name)}&role=player`);
  ws.got = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    // Echo RTT probes like player.html does (feeds the server's
    // latency-equalized arbitration; see qb-moderator SPEC.md).
    if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', n: m.n, ts: m.ts })); return; }
    ws.got.push(m);
  };
  ws.next = (pred, why, ms) => wait(() => {
    const i = ws.got.findIndex(pred);
    return i >= 0 ? ws.got.splice(i, 1)[0] : null;
  }, why, ms);
  ws.sendJson = (o) => ws.send(JSON.stringify(o));
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('ws error connecting ' + name));
  });
}

// --- create + host connect via the vendored client ---
const code = await createRoom(SERVER);
if (!/^[A-Z2-9]{4}$/.test(code)) fail('bad room code: ' + code);
ok('room created via vendored createRoom: ' + code);

const events = { buzzes: [], joins: [], leaves: [], opens: 0 };
const room = connectHost(code, {
  onOpen: () => { events.opens++; },
  onBuzz: (name) => events.buzzes.push(name),
  onJoin: (name) => events.joins.push(name),
  onLeave: (name) => events.leaves.push(name),
}, SERVER);
await wait(() => events.opens > 0, 'host connected');
ok('vendored connectHost connected');

// --- consensus-shaped snapshot relay ---
const snapshot = {
  type: 'state',
  teamA: { name: 'Alphas', score: 10, players: [{ name: 'Kim', points: 10 }] },
  teamB: { name: 'Bravos', score: 0, players: [{ name: 'Pat', points: 0 }] },
  qNum: 2, qTotal: 100, category: 'Set of 4: Rivers', posNum: 2, posTotal: 4,
  packName: 'E2E Pack', splitPair: null, jailbreak: null,
  answered: { name: 'Kim', team: 'Alphas', teamLetter: 'a', points: 10 },
};
room.send({ t: 'state', snapshot });

const kim = await connectPlayer(code, 'Kim');
const w = await kim.next((m) => m.t === 'welcome', 'Kim welcome');
if (w.snapshot?.teamA?.players?.[0]?.points !== 10) fail('welcome snapshot lost consensus shape');
ok('consensus snapshot survives the relay + late-join storage');
await wait(() => events.joins.includes('Kim'), 'host sees Kim join');
ok('host onJoin');

// --- buzz round-trip through the vendored host handlers ---
room.send({ t: 'arm' });
await kim.next((m) => m.t === 'arm', 'Kim armed');
kim.sendJson({ t: 'buzz' });
await wait(() => events.buzzes.includes('Kim'), 'host onBuzz');
ok('buzz round-trip (gate closes)');
kim.sendJson({ t: 'buzz' });
await kim.next((m) => m.t === 'rejected', 'second buzz rejected');
ok('closed-gate buzz rejected');

// --- silent re-arm (what the host does for locked/spectator buzzes) ---
room.send({ t: 'arm' });
await kim.next((m) => m.t === 'arm', 'Kim re-armed');
ok('re-arm cycle');

// --- consensus qlog relay ---
room.send({ t: 'qlog', qlog: [{ label: 'Q1', category: 'Rivers', question: 'Which river?', answerHtml: '<b>Nile</b>', summary: 'Kim +10 (Alphas)' }] });
await kim.next((m) => m.t === 'qlog' && m.qlog[0]?.answerHtml === '<b>Nile</b>', 'qlog relay');
ok('consensus qlog relay');

// --- spectator-sentinel join: reaches the host (filtered client-side) ---
const watcher = await connectPlayer(code, '~watch·e2e');
await watcher.next((m) => m.t === 'welcome', 'watcher welcome');
await wait(() => events.joins.includes('~watch·e2e'), 'host sees watcher join');
ok('spectator sentinel joins as a player (host filters by prefix)');

// --- leave fan-out ---
kim.close();
await wait(() => events.leaves.includes('Kim'), 'host sees Kim leave');
ok('leave fan-out');

watcher.close();
room.close();
console.log('CONSENSUS ROOMS E2E: all passed');
process.exit(0);
