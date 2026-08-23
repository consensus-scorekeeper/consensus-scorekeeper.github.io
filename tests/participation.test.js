// Substitutions — the pure half (util/participation.js): benched
// intervals → per-slot availability → Played fraction → CSV cell and
// back. The reducers that write the intervals are covered in
// state-mutations.test.js; the jailbreak consequence in jailbreak.test.js.

import { describe, it, expect } from 'vitest';
import {
  isBenched, isBenchedAt, playableSlots, slotsPlayed, playedFraction,
  formatPlayed, parsePlayed,
} from '../src/util/participation.js';

const slots = (n, missing = []) => Array.from({ length: n }, (_, i) => ({ num: i + 1, isMissing: missing.includes(i) }));

describe('isBenched / isBenchedAt', () => {
  it('a player with no subs (pre-feature rosters, saved games) is never benched', () => {
    expect(isBenched({ name: 'A', points: 0 })).toBe(false);
    expect(isBenchedAt({ name: 'A', points: 0 }, 42)).toBe(false);
    expect(isBenched({ name: 'A', points: 0, subs: [] })).toBe(false);
  });

  it('an open interval benches from `out` onward; a closed one up to (not including) `in`', () => {
    const out = { subs: [{ out: 50, in: null }] };
    expect(isBenched(out)).toBe(true);
    expect(isBenchedAt(out, 49)).toBe(false);
    expect(isBenchedAt(out, 50)).toBe(true);
    expect(isBenchedAt(out, 99)).toBe(true);

    const back = { subs: [{ out: 50, in: 75 }] };
    expect(isBenched(back)).toBe(false);
    expect(isBenchedAt(back, 74)).toBe(true);
    expect(isBenchedAt(back, 75)).toBe(false);
  });

  it('multiple intervals each count', () => {
    const p = { subs: [{ out: 10, in: 20 }, { out: 60, in: null }] };
    expect(isBenched(p)).toBe(true);
    expect([5, 10, 19, 20, 59, 60].map((s) => isBenchedAt(p, s))).toEqual([false, true, true, false, false, true]);
  });
});

describe('playableSlots / slotsPlayed / playedFraction', () => {
  it('counts every real slot, skipping packet gaps', () => {
    expect(playableSlots(slots(5)).length).toBe(5);
    expect(playableSlots(slots(5, [1, 3]))).toEqual([0, 2, 4]);
    expect(playableSlots([])).toEqual([]);
    expect(playableSlots(null)).toEqual([]);
  });

  it('is 1 with nothing to measure against', () => {
    expect(playedFraction({ subs: [{ out: 0, in: null }] }, [])).toBe(1);
  });

  it('halftime sub-out of a 100-slot pack is exactly half', () => {
    const p = { subs: [{ out: 50, in: null }] };
    expect(slotsPlayed(p, slots(100))).toBe(50);
    expect(playedFraction(p, slots(100))).toBe(0.5);
  });

  it('gaps in the packet are excluded from both numerator and denominator', () => {
    // 100 slots, 4 missing inside the benched stretch: 96 playable, 46 benched.
    const qs = slots(100, [52, 53, 54, 55]);
    const p = { subs: [{ out: 50, in: null }] };
    expect(slotsPlayed(p, qs)).toBe(50);
    expect(playedFraction(p, qs)).toBeCloseTo(50 / 96, 10);
  });

  it('in-then-out-again adds up', () => {
    const p = { subs: [{ out: 0, in: 25 }, { out: 75, in: null }] };
    expect(playedFraction(p, slots(100))).toBe(0.5);
  });
});

describe('formatPlayed / parsePlayed (the CSV cell)', () => {
  it('writes short decimals and reads them back', () => {
    expect(formatPlayed(1)).toBe('1');
    expect(formatPlayed(0.5)).toBe('0.5');
    expect(formatPlayed(0.37)).toBe('0.37');
    expect(formatPlayed(37 / 97)).toBe('0.381');
    expect(parsePlayed('0.381')).toBe(0.381);
    expect(parsePlayed(formatPlayed(0.5))).toBe(0.5);
  });

  it('defaults to a full game for the pre-column CSVs and clamps junk', () => {
    expect(parsePlayed(undefined)).toBe(1);
    expect(parsePlayed('')).toBe(1);
    expect(parsePlayed('  ')).toBe(1);
    expect(parsePlayed('abc')).toBe(1);
    expect(parsePlayed('3')).toBe(1);
    expect(parsePlayed('-1')).toBe(0);
    expect(parsePlayed(0.25)).toBe(0.25);
    expect(formatPlayed(7)).toBe('1');
  });
});
