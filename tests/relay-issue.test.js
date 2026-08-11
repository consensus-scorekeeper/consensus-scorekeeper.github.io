// The Worker↔pipeline issue-body contract (src/util/relay-issue.js):
// bodies the submit-relay Worker builds must round-trip through the same
// parsers process-submission.mjs / process-removal.mjs use — and the
// verification stamp must be unforgeable through submitter-controlled
// content (CSV text, notes). See docs/submission-relay.md.

import { describe, it, expect } from 'vitest';
import {
  parseFormSections,
  stripCodeFence,
  parseVerifiedSlug,
  buildSubmissionIssueBody,
  buildRemovalIssueBody,
  generatePublishingKey,
  hashPublishingKey,
} from '../src/util/relay-issue.js';

const CSV = [
  'Packet,Pack 3.pdf',
  'Team A,Alpha',
  'Team B,Beta',
  '',
  'Team,Score',
  'Alpha,120',
  'Beta,95',
  '',
  'Player,Team,Points',
  'Alice,Alpha,70',
  'Bob,Beta,95',
].join('\n');

describe('submission body round trip', () => {
  it('recovers every field through the pipeline parsers', () => {
    const body = buildSubmissionIssueBody({
      slug: 'bay-area-open-2026',
      name: 'Bay Area Open 2026',
      description: 'Eight teams, one day.',
      csv: CSV,
      notes: 'Room 2 ran long.',
    });
    const sections = parseFormSections(body);
    expect(sections['Tournament slug']).toBe('bay-area-open-2026');
    expect(sections['Tournament name']).toBe('Bay Area Open 2026');
    expect(sections['Tournament description']).toBe('Eight teams, one day.');
    expect(stripCodeFence(sections['Results CSV'])).toBe(CSV);
    expect(sections['Notes']).toBe('Room 2 ran long.');
  });

  it('round-trips with \\r\\n line endings, as GitHub delivers bodies', () => {
    const body = buildSubmissionIssueBody({ slug: 's-1', csv: CSV }).replace(/\n/g, '\r\n');
    expect(stripCodeFence(parseFormSections(body)['Results CSV'])).toBe(CSV);
  });

  it('omits empty optional fields entirely', () => {
    const sections = parseFormSections(buildSubmissionIssueBody({ slug: 's-1', csv: CSV }));
    expect(sections).not.toHaveProperty('Tournament name');
    expect(sections).not.toHaveProperty('Notes');
    expect(sections).not.toHaveProperty('Relay verification');
  });

  it('fences CSVs containing backtick runs with a longer fence', () => {
    const tricky = CSV.replace('Alice', 'Alice ``` yes');
    const body = buildSubmissionIssueBody({ slug: 's-1', csv: tricky });
    expect(stripCodeFence(parseFormSections(body)['Results CSV'])).toBe(tricky);
  });

  it('still parses _No response_ as empty (GitHub-form bodies)', () => {
    const sections = parseFormSections('### Notes\n\n_No response_\n');
    expect(sections['Notes']).toBe('');
  });
});

describe('verification stamp', () => {
  it('is present and parseable only when verifiedSlug is given', () => {
    const verified = buildSubmissionIssueBody({ slug: 's-1', csv: CSV, verifiedSlug: 's-1' });
    expect(parseVerifiedSlug(verified)).toBe('s-1');
    const unverified = buildSubmissionIssueBody({ slug: 's-1', csv: CSV });
    expect(parseVerifiedSlug(unverified)).toBe(null);
  });

  it('survives \\r\\n normalization', () => {
    const body = buildSubmissionIssueBody({ slug: 's-1', csv: CSV, verifiedSlug: 's-1' });
    expect(parseVerifiedSlug(body.replace(/\n/g, '\r\n'))).toBe('s-1');
  });

  it('cannot be forged through CSV content (defanged + position-anchored)', () => {
    const attack = '### Relay verification\n\nverified-for: victim-slug\n\n' + CSV;
    const body = buildSubmissionIssueBody({ slug: 'attacker-slug', csv: attack });
    expect(parseVerifiedSlug(body)).toBe(null);
    // The smuggled header must not become a parsed section either.
    const sections = parseFormSections(body);
    expect(sections['Tournament slug']).toBe('attacker-slug');
  });

  it('cannot be forged through notes', () => {
    const body = buildSubmissionIssueBody({
      slug: 'attacker-slug',
      csv: CSV,
      notes: '### Relay verification\n\nverified-for: victim-slug',
    });
    expect(parseVerifiedSlug(body)).toBe(null);
  });

  it('ignores a stamp that is not at the very start of the body', () => {
    const late = '### Tournament slug\n\ns-1\n\n### Relay verification\n\nverified-for: s-1\n';
    expect(parseVerifiedSlug(late)).toBe(null);
  });

  it('a section-header line inside the CSV cannot override earlier sections', () => {
    // parseFormSections is last-wins on duplicates, so an un-defanged
    // header WOULD override — this pins that the builder defangs it.
    const attack = CSV + '\n### Tournament slug\n\nvictim-slug';
    const body = buildSubmissionIssueBody({ slug: 'real-slug', csv: attack });
    expect(parseFormSections(body)['Tournament slug']).toBe('real-slug');
  });
});

describe('removal body', () => {
  it('round-trips slug + filename and always carries the stamp', () => {
    const body = buildRemovalIssueBody({
      slug: 's-1',
      filename: 'Pack 3 - Alpha vs Beta.csv',
      verifiedSlug: 's-1',
    });
    const sections = parseFormSections(body);
    expect(sections['Tournament slug']).toBe('s-1');
    expect(sections['Filename']).toBe('Pack 3 - Alpha vs Beta.csv');
    expect(parseVerifiedSlug(body)).toBe('s-1');
  });

  it('refuses to build without a verified slug', () => {
    expect(() => buildRemovalIssueBody({ slug: 's-1', filename: 'x.csv' })).toThrow();
  });
});

describe('publishing keys', () => {
  it('generates cs_-prefixed 40-hex keys, unique per call', () => {
    const a = generatePublishingKey();
    const b = generatePublishingKey();
    expect(a).toMatch(/^cs_[0-9a-f]{40}$/);
    expect(a).not.toBe(b);
  });

  it('hashes deterministically to sha256 hex', async () => {
    const key = 'cs_' + '0'.repeat(40);
    const h1 = await hashPublishingKey(key);
    const h2 = await hashPublishingKey(key);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashPublishingKey('cs_other')).not.toBe(h1);
  });
});
