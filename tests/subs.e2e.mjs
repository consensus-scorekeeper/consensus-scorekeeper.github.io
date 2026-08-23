// NOT vitest/CI: drives the real app in headless Chrome (puppeteer-core,
// see .claude/skills/verify) through the substitution flow — sub out a
// player on a jailbreak, confirm the team's lock cycles after the
// available players buzz, sub back in, export the CSV, check Played.
//
//   node tests/subs.e2e.mjs            (serve.py on :8000, puppeteer-core
//                                       resolvable from /tmp/pptr)

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(path.join(process.env.PPTR_DIR || path.join(os.tmpdir(), 'pptr'), 'x.js'));
const puppeteer = require('puppeteer-core');
const BASE = process.env.BASE || 'http://localhost:8000';
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'subs-e2e-'));
// A tiny authored-format pack with a Jailbreak set (the bundled sample
// pack has none) — 12 questions clears the >=10 acceptance gate.
const PACK = path.join(DL, 'jailbreak-pack.txt');
const q = (n) => `${n}. Question ${n}?\nA: Answer ${n}`;
fs.writeFileSync(PACK, [
  'Warm-up', q(1), q(2), q(3), '',
  'Jailbreak', q(4), q(5), q(6), q(7), q(8), q(9), '',
  'Cool-down', q(10), q(11), q(12), '',
].join('\n'));

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
page.on('response', (r) => { if (r.status() >= 400 && !/favicon.ico/.test(r.url())) errors.push(`http ${r.status()} ${r.url()}`); });
page.on('dialog', (d) => d.accept());
const cdp = await page.target().createCDPSession();
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

const fail = (msg) => { console.error('FAIL: ' + msg); process.exitCode = 1; };
const assert = (cond, msg) => { if (!cond) fail(msg); else console.log('ok   ' + msg); };

await page.goto(BASE + '/', { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });

// Upload a pack, 5 v 2 rosters, start.
const input = await page.$('#pdf-input');
await input.uploadFile(PACK);
await page.waitForFunction(() => /question/i.test(document.getElementById('pdf-status')?.textContent || ''), { timeout: 10000 });
const addPlayer = async (team, name) => { await page.type(`#add-player-${team}`, name); await page.click(`[data-action="add-player"][data-team="${team}"]`); };
for (const n of ['A1', 'A2', 'A3', 'A4', 'A5']) await addPlayer('a', n);
for (const n of ['B1', 'B2']) await addPlayer('b', n);
await page.click('[data-action="start-game"]');
await page.waitForSelector('#game', { visible: true });

// Jump to the pack's first jailbreak question.
const jbIdx = await page.evaluate(async () => {
  const { state } = await import('/src/state.js');
  return state.questions.findIndex((q) => q.category && /jailbreak/i.test(q.category));
});
assert(jbIdx >= 0, `sample pack has a jailbreak set (slot ${jbIdx + 1})`);
await page.click(`[data-action="goto"][data-index="${jbIdx}"]`);

const settle = () => new Promise((r) => setTimeout(r, 150));
const rowA = (i) => `#panel-a .player-row[data-index="${i}"]`;
const locked = () => page.evaluate(async () => { const { state } = await import('/src/state.js'); return [...state.jailbreakLocked.a]; });

// Sub out A5 via the row's right-click menu.
const pickMenu = async (row, action) => { await page.click(row, { button: 'right' }); await page.waitForSelector(`#player-menu button[data-menu="${action}"]`, { visible: true }); await page.click(`#player-menu button[data-menu="${action}"]`); await settle(); };
await pickMenu(rowA(4), 'sub-out');
assert(await page.$(`${rowA(4)}.player-row-benched`) !== null, 'A5 row renders benched');
assert(await page.$(`${rowA(4)} [data-action="add-points"]`) === null, 'benched row has no +10');
assert((await page.$eval(`${rowA(4)} .player-sub-tag`, (el) => el.textContent)) === `out since Q${jbIdx + 1}`, 'benched tag says out since the current question');

// Four available players buzz (keys 1-4 score + auto-advance within the set).
for (const k of ['1', '2', '3']) { await page.keyboard.press(k); await settle(); }
assert(JSON.stringify(await locked()) === '[0,1,2]', 'three buzzes → three locks');
await page.keyboard.press('4'); await settle();
assert(JSON.stringify(await locked()) === '[]', 'THE BUG: lock cycles after the 4 available players (A5 on the bench)');

// Sub A5 back in (menu now offers Sub in).
await pickMenu(rowA(4), 'sub-in');
assert(await page.$(`${rowA(4)}.player-row-benched`) === null, 'Sub in restores the row');
assert(await page.$(`${rowA(4)} [data-action="add-points"]`) !== null, '+10 is back');

// Export CSV and check the Played column.
const subs = await page.evaluate(async () => { const { state } = await import('/src/state.js'); return state.teamA.players.map((p) => p.subs || []); });
console.log('     subs:', JSON.stringify(subs));
await page.click('[data-action="export-csv"]');
await new Promise((r) => setTimeout(r, 1500));
const csvFile = fs.readdirSync(DL).find((f) => f.endsWith('.csv'));
assert(!!csvFile, 'CSV downloaded');
const csv = fs.readFileSync(path.join(DL, csvFile), 'utf8');
const lines = csv.split(/\r?\n/);
assert(lines.includes('Player,Team,Points,Played'), 'players header has Played');
const a5 = lines.find((l) => l.startsWith('A5,'));
console.log('     ' + lines.filter((l) => /^A[1-5],|^B[12],/.test(l)).join(' | '));
const played = parseFloat(a5.split(',')[3]);
// 12 real slots in the pack (the padding to 100 is isMissing); A5 sat out 4.
assert(played === 0.667, `A5 Played = 8/12 (${played}) — sat out Q${jbIdx + 1}..Q${jbIdx + 4}`);
assert(lines.find((l) => l.startsWith('A1,')).endsWith(',1'), 'A1 Played = 1');

// Reload → state restores with subs intact (resume), and the pop-out
// snapshot carries benched.
await page.evaluate(async () => { const { subOut } = await import('/src/state.js'); subOut('b', 1); });
await page.reload({ waitUntil: 'load' });
await page.click('#resume-btn');
const restored = await page.evaluate(async () => {
  const { state } = await import('/src/state.js');
  const { getScoreboardSnapshot } = await import('/src/ui/scoreboard-popout.js');
  return { subs: state.teamB.players[1].subs, benched: getScoreboardSnapshot().teamB.players[1].benched };
});
assert(restored.subs && restored.subs.length === 1 && restored.benched === true, 'subs survive reload; snapshot flags benched');

assert(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
console.log(process.exitCode ? 'E2E FAILED' : 'E2E PASSED');
