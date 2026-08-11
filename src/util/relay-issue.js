// The issue-body contract between the submit-relay Worker and the
// results-submission pipeline (see docs/submission-relay.md).
//
// The Worker builds issue bodies with the builders here; the pipeline
// (scripts/process-submission.mjs, scripts/process-removal.mjs) parses
// them with the parsers here — the same parsers that handle bodies from
// the GitHub issue form, since both render "### <field label>" sections.
// tests/relay-issue.test.js round-trips builders through parsers so the
// two ends can't drift.
//
// Security: the Worker authors the whole body, so anything a submitter
// controls (CSV text, notes) could try to smuggle in its own "### "
// section — most dangerously a forged "Relay verification" stamp, which
// would otherwise pass the pipeline's author check (the relay bot did
// author the issue). Two independent defenses:
//   1. Builders neutralize user content: section-header lines inside
//      multiline values are escaped, single-line values lose newlines.
//   2. The stamp is position-anchored: parseVerifiedSlug only accepts a
//      stamp at the very start of the body, where the builders put it —
//      user content can only ever appear after it.
//
// Pure — no DOM, no IO (WebCrypto only). Runs in the browser, the
// Worker, and Node.

import { isValidTournamentSlug } from './submission.js';

export const RESULTS_LABEL = 'results-submission';
export const REMOVAL_LABEL = 'game-removal';

// ---------- parsing (issue form and relay bodies alike) ----------

// Issue-form submissions render as "### <field label>\n\n<value>" blocks.
// GitHub delivers issue bodies with \r\n line endings — normalize first.
// Duplicate labels: the last occurrence wins, so nothing here may be
// trusted for verification (see parseVerifiedSlug).
export function parseFormSections(body) {
  const sections = {};
  const parts = String(body || '').replace(/\r\n/g, '\n').split(/^### +(.+?) *$/m);
  for (let i = 1; i < parts.length; i += 2) {
    let value = (parts[i + 1] || '').trim();
    if (value === '_No response_') value = '';
    sections[parts[i]] = value;
  }
  return sections;
}

// The "Results CSV" textarea uses `render: text`, so GitHub fences it
// with ``` — and the relay fences with a longer run when the CSV itself
// contains backtick runs, hence the backreference.
export function stripCodeFence(text) {
  const m = /^(`{3,})[a-z]*\n([\s\S]*?)\n?\1$/m.exec(String(text || '').trim());
  return m ? m[2] : String(text || '');
}

// ---------- the verification stamp ----------

const STAMP_HEADER = '### Relay verification';

// Only a stamp at the very start of the body counts — the builders place
// it there, before any submitter-controlled content, so a "### Relay
// verification" section smuggled into a CSV or notes field can never be
// the one this reads. (parseFormSections' last-wins duplicate handling
// is exactly why the stamp must NOT be read via parseFormSections.)
export function parseVerifiedSlug(body) {
  const normalized = String(body || '').replace(/\r\n/g, '\n').trimStart() + '\n';
  const m = /^### Relay verification\n\nverified-for: ([a-z0-9-]{1,60})\n/.exec(normalized);
  return m && isValidTournamentSlug(m[1]) ? m[1] : null;
}

// ---------- body builders (Worker-side) ----------

// A single-line field may not introduce new lines (and so can never
// start a section header of its own).
function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// In multiline values, defang any line that would parse as a section
// header. The leading backslash renders visibly and survives into the
// pipeline unchanged — acceptable, since legitimate CSVs and notes have
// no reason to start a line with "### ".
function defangSections(value) {
  return String(value || '').replace(/^### /gm, '\\### ');
}

// Fence with more backticks than the longest run inside, so the content
// can't close its own fence.
function fence(value) {
  const longest = Math.max(2, ...[...String(value).matchAll(/`+/g)].map((m) => m[0].length));
  const marks = '`'.repeat(Math.max(3, longest + 1));
  return `${marks}text\n${value}\n${marks}`;
}

function section(label, value) {
  return `### ${label}\n\n${value}`;
}

function stamp(verifiedSlug) {
  if (!verifiedSlug) return [];
  if (!isValidTournamentSlug(verifiedSlug)) throw new Error('invalid verified slug');
  return [section('Relay verification', `verified-for: ${verifiedSlug}`)];
}

// Body for a results submission filed by the relay. Field labels must
// match .github/ISSUE_TEMPLATE/submit-results.yml — process-submission.mjs
// reads both sources through the same labels.
export function buildSubmissionIssueBody({ slug, name, description, csv, notes, verifiedSlug }) {
  const parts = [
    ...stamp(verifiedSlug),
    section('Tournament slug', singleLine(slug)),
  ];
  if (singleLine(name)) parts.push(section('Tournament name', singleLine(name)));
  if (singleLine(description)) parts.push(section('Tournament description', singleLine(description)));
  parts.push(section('Results CSV', fence(defangSections(csv))));
  if (String(notes || '').trim()) parts.push(section('Notes', defangSections(String(notes).trim())));
  return parts.join('\n\n') + '\n';
}

// Body for a game-removal request. Removal is only ever key-verified, so
// the stamp is mandatory.
export function buildRemovalIssueBody({ slug, filename, verifiedSlug }) {
  if (!verifiedSlug) throw new Error('removal requires a verified slug');
  return [
    ...stamp(verifiedSlug),
    section('Tournament slug', singleLine(slug)),
    section('Filename', singleLine(filename)),
  ].join('\n\n') + '\n';
}

// ---------- publishing keys ----------

// Format: cs_<40 hex>. Only the SHA-256 of a key is ever stored (Worker
// KV); the plaintext exists client-side and in the TD's password manager.
export function generatePublishingKey() {
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  return 'cs_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPublishingKey(key) {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(key))
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
