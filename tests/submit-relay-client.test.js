// Client half of the submit-relay (util/submit-relay.js): publishing-key
// storage, and the key-handout link round trip (keyHandoutUrl builds the
// fragment link that stats-main.js's parseKeyFromHash consumes).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  relayEnabled,
  loadPublishingKeys,
  getPublishingKey,
  savePublishingKey,
  keyHandoutUrl,
  parseKeyFromHash,
  SITE_BASE,
} from '../src/util/submit-relay.js';

const KEY = 'cs_' + 'ab'.repeat(20);

describe('publishing-key storage', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips keys per slug', () => {
    savePublishingKey('a-open-2026', KEY);
    savePublishingKey('b-open-2026', 'cs_' + 'cd'.repeat(20));
    expect(getPublishingKey('a-open-2026')).toBe(KEY);
    expect(Object.keys(loadPublishingKeys()).sort()).toEqual(['a-open-2026', 'b-open-2026']);
  });

  it('falsy key deletes the entry', () => {
    savePublishingKey('a-open-2026', KEY);
    savePublishingKey('a-open-2026', '');
    expect(getPublishingKey('a-open-2026')).toBe('');
    expect(loadPublishingKeys()).toEqual({});
  });

  it('tolerates corrupted storage', () => {
    localStorage.setItem('consensus-tournament-keys-v1', '{not json');
    expect(loadPublishingKeys()).toEqual({});
    savePublishingKey('a-open-2026', KEY); // and recovers on write
    expect(getPublishingKey('a-open-2026')).toBe(KEY);
  });
});

describe('key-handout links', () => {
  it('builds a fragment link on the canonical site that parses back', () => {
    const url = keyHandoutUrl('a-open-2026', KEY);
    expect(url).toBe(`${SITE_BASE}/tournaments/preview.html?slug=a-open-2026#key=${KEY}`);
    expect(parseKeyFromHash(new URL(url).hash)).toBe(KEY);
  });

  it('rejects junk fragments', () => {
    for (const hash of ['', '#key=', '#key=notakey', '#key=cs_short', `#key=${KEY}&x=1`, '#other']) {
      expect(parseKeyFromHash(hash), hash).toBe('');
    }
  });

  it('relay is enabled in the shipped config', () => {
    expect(relayEnabled()).toBe(true);
  });
});
