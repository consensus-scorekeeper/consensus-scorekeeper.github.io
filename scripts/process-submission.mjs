// Processes a "Submit game results" issue (the .github/ISSUE_TEMPLATE/
// submit-results.yml form) inside the process-submission workflow.
//
// Reads the issue body from GITHUB_EVENT_PATH, extracts the tournament
// slug + pasted CSV text + any attached .csv/.txt files, validates every
// game, and writes them into tournaments/<slug>/results/ in the checkout.
// The workflow then turns the working-tree changes into a PR.
//
// Communication back to the workflow:
//   $GITHUB_OUTPUT  — status=ok|invalid, plus added/updated counts
//   $RUNNER_TEMP/summary.md — markdown posted as an issue comment
//
// Reuses the site's own pure modules (package.json is "type": "module",
// so Node imports them directly): parseResultsCsv for the format,
// TOURNAMENTS for slug validation, util/submission.js for bundle
// splitting and add-vs-replace planning.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResultsCsv } from '../src/util/parse-results-csv.js';
import { TOURNAMENTS } from '../src/ui/roster-presets.js';
import {
  splitCsvBundle,
  planSubmissionWrites,
} from '../src/util/submission.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- issue-form body parsing ----------

// Issue-form submissions render as "### <field label>\n\n<value>" blocks.
// GitHub delivers issue bodies with \r\n line endings — normalize first.
function parseFormSections(body) {
  const sections = {};
  const parts = String(body || '').replace(/\r\n/g, '\n').split(/^### +(.+?) *$/m);
  for (let i = 1; i < parts.length; i += 2) {
    let value = (parts[i + 1] || '').trim();
    if (value === '_No response_') value = '';
    sections[parts[i]] = value;
  }
  return sections;
}

// The "Results CSV" textarea uses `render: text`, so GitHub fences it.
function stripCodeFence(text) {
  const m = /^```[a-z]*\n([\s\S]*?)\n?```$/m.exec(String(text || '').trim());
  return m ? m[1] : String(text || '');
}

// Attachment links GitHub inserts on drag-and-drop. Both the current
// user-attachments form and the legacy per-repo /files/ form.
const ATTACHMENT_RE =
  /https:\/\/github\.com\/(?:user-attachments\/files|[\w.-]+\/[\w.-]+\/files)\/\d+\/[^\s)"'<>\]]+/g;

async function fetchAttachments(body) {
  const urls = [...new Set(String(body || '').match(ATTACHMENT_RE) || [])]
    .filter((u) => /\.(csv|txt)$/i.test(u));
  const texts = [];
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download attachment (${res.status}): ${url}`);
    texts.push(await res.text());
  }
  return { count: urls.length, texts };
}

// ---------- validation ----------

function validateGame(chunk, index) {
  const errors = [];
  let parsed = null;
  try {
    parsed = parseResultsCsv(chunk);
  } catch (e) {
    errors.push(`Game ${index + 1}: could not be parsed as a results CSV (${e.message}).`);
    return { parsed: null, errors };
  }
  const label = `Game ${index + 1} (${parsed.packet || 'unknown packet'})`;
  if (!parsed.teamA || !parsed.teamB) {
    errors.push(`${label}: missing "Team A" / "Team B" metadata rows — is this an unmodified export from the scorekeeper?`);
  }
  if (parsed.players.length === 0) {
    errors.push(`${label}: no player rows found.`);
  }
  return { parsed, errors };
}

// ---------- main ----------

const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const issue = event.issue;
const sections = parseFormSections(issue.body);

const slug = (sections['Tournament slug'] || '').trim();
const pasted = stripCodeFence(sections['Results CSV'] || '');

const errors = [];
const warnings = [];

const tournament = TOURNAMENTS.find((t) => t.slug === slug);
if (!slug) {
  errors.push('No tournament slug given.');
} else if (!tournament) {
  errors.push(
    `Unknown tournament slug \`${slug}\`. Valid slugs: ${TOURNAMENTS.map((t) => `\`${t.slug}\``).join(', ')}.`
  );
}

let attachments = { count: 0, texts: [] };
try {
  attachments = await fetchAttachments(issue.body);
} catch (e) {
  errors.push(e.message);
}

const chunks = [pasted, ...attachments.texts].flatMap((t) => splitCsvBundle(t));
if (chunks.length === 0) {
  errors.push('No results CSV found — paste the exported CSV into the "Results CSV" box or attach the .csv file.');
}

const games = [];
for (const [i, chunk] of chunks.entries()) {
  const { parsed, errors: gameErrors } = validateGame(chunk, i);
  errors.push(...gameErrors);
  if (parsed && gameErrors.length === 0) games.push({ content: chunk, parsed });
}

let writes = [];
if (errors.length === 0) {
  // Team names are deliberately NOT checked against the tournament's
  // registry rosters: subs happen, rosters drift, and the stats
  // aggregation keys purely on the names in the CSV. The maintainer
  // sees the team names in the PR diff before anything publishes.
  const resultsDir = path.join(repoRoot, 'tournaments', tournament.slug, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const existing = [];
  for (const filename of fs.readdirSync(resultsDir)) {
    if (!/\.csv$/i.test(filename)) continue;
    try {
      existing.push({
        filename,
        parsed: parseResultsCsv(fs.readFileSync(path.join(resultsDir, filename), 'utf8')),
      });
    } catch { /* unparseable published file — leave it alone */ }
  }

  const plan = planSubmissionWrites(existing, games);
  writes = plan.writes;
  warnings.push(...plan.warnings);

  for (const w of writes) {
    // Match the exporter's on-disk format exactly: BOM + CRLF.
    fs.writeFileSync(
      path.join(resultsDir, w.filename),
      '﻿' + w.content.replace(/\n/g, '\r\n') + '\r\n'
    );
  }
}

// ---------- report ----------

const lines = [];
if (errors.length > 0) {
  lines.push('### ❌ Submission could not be processed', '');
  lines.push(...errors.map((e) => `- ${e}`));
  lines.push('', 'Edit the issue to fix the problem(s) above — the check reruns automatically on every edit.');
} else {
  const added = writes.filter((w) => w.action === 'add');
  const updated = writes.filter((w) => w.action === 'update');
  lines.push(`### ✅ ${games.length} game${games.length === 1 ? '' : 's'} validated for **${tournament.name}**`, '');
  for (const w of added) lines.push(`- 🆕 \`${w.filename}\``);
  for (const w of updated) lines.push(`- ♻️ \`${w.filename}\` (replaces the previously published version of this game)`);
}
if (warnings.length > 0) {
  lines.push('', '**Warnings:**', ...warnings.map((w) => `- ⚠️ ${w}`));
}

fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'summary.md'), lines.join('\n') + '\n');
fs.appendFileSync(
  process.env.GITHUB_OUTPUT,
  `status=${errors.length === 0 ? 'ok' : 'invalid'}\n` +
  `slug=${tournament ? tournament.slug : ''}\n`
);
console.log(lines.join('\n'));
