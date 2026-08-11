// Processes a "Remove game" issue (filed only by the submit-relay Worker
// after verifying the tournament's publishing key) inside the
// process-removal workflow: deletes one published CSV from
// tournaments/<slug>/results/. Design: docs/submission-relay.md.
//
// Trust checks repeated here even though the Worker already made them —
// anyone can open an issue and slap the game-removal label on it:
//   - the issue author must be the relay bot (only the Worker can be),
//   - the position-anchored verification stamp must name the same slug
//     as the form section,
//   - the filename must be a bare *.csv basename, and the deletion path
//     is built from the STAMPED slug — path traversal has no inputs left.
//
// Communication back to the workflow:
//   $GITHUB_OUTPUT  — status=ok|missing|invalid, slug=<slug>
//   $RUNNER_TEMP/summary.md — markdown posted as an issue comment

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFormSections, parseVerifiedSlug } from '../src/util/relay-issue.js';
import { isValidTournamentSlug } from '../src/util/submission.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const issue = event.issue;
const sections = parseFormSections(issue.body);

const slug = (sections['Tournament slug'] || '').trim();
const filename = (sections['Filename'] || '').trim();
const relayBot = process.env.RELAY_BOT_LOGIN || 'consensus-submit-relay[bot]';

const errors = [];
if (!issue.user || issue.user.login !== relayBot) {
  errors.push('Game removal only works through the site’s "Remove this game" action (a verified publishing key is required).');
}
if (!isValidTournamentSlug(slug)) {
  errors.push('Invalid tournament slug.');
} else if (parseVerifiedSlug(issue.body) !== slug) {
  errors.push('Missing or mismatched relay verification stamp.');
}
if (!/^[^/\\]+\.csv$/i.test(filename) || filename.includes('..')) {
  errors.push('Invalid filename — a bare `<name>.csv` is required.');
}

let status = 'invalid';
const lines = [];
if (errors.length > 0) {
  lines.push('### ❌ Removal request rejected', '', ...errors.map((e) => `- ${e}`));
} else {
  const target = path.join(repoRoot, 'tournaments', slug, 'results', filename);
  if (!fs.existsSync(target)) {
    status = 'missing';
    lines.push(
      `### ⚠️ Nothing to remove`,
      '',
      `\`${filename}\` is not (or no longer) published under **${slug}** — ` +
      'it may have been removed already, or renamed by a correction.'
    );
  } else {
    fs.unlinkSync(target);
    status = 'ok';
    lines.push(
      `### 🗑️ Game removed from **${slug}**`,
      '',
      `- \`${filename}\` is no longer published; the stats page updates in a couple of minutes.`,
      '',
      'Removed by mistake? Just submit the game again from the site.'
    );
  }
}

fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'summary.md'), lines.join('\n') + '\n');
fs.appendFileSync(
  process.env.GITHUB_OUTPUT,
  `status=${status}\nslug=${slug}\n`
);
console.log(lines.join('\n'));
