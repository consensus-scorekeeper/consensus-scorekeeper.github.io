import { describe, it, expect } from 'vitest';
import { cleanTrailing } from '../src/main.js';

describe('cleanTrailing', () => {
  it('strips trailing "PACK N" headers', () => {
    expect(cleanTrailing('the answer is X PACK 3 of 10')).toBe('the answer is X');
  });

  it('strips trailing "Set of N" suffix (case-insensitive regex tail)', () => {
    expect(cleanTrailing('correct response Set of 4: Famous Authors')).toBe('correct response');
  });

  it('strips trailing "Splits:" suffix', () => {
    expect(cleanTrailing('answer text Splits: 1 vs 2')).toBe('answer text');
  });

  it('strips trailing "Streak" suffix', () => {
    expect(cleanTrailing('foo Streak')).toBe('foo');
    expect(cleanTrailing('foo Streaks of 5')).toBe('foo');
  });

  it('strips uppercase section markers (END OF / FIRST QUARTER)', () => {
    expect(cleanTrailing('the answer END OF FIRST QUARTER')).toBe('the answer');
    expect(cleanTrailing('the answer FIRST HALF')).toBe('the answer');
  });

  it('is CASE-SENSITIVE for SECTION_WORDS so prose is preserved', () => {
    // Critical regression target: a lowercase "second half" inside legitimate
    // question text must NOT be truncated.
    const s = 'blew a 12-point second half lead';
    expect(cleanTrailing(s)).toBe(s);
  });

  it('trims trailing whitespace', () => {
    expect(cleanTrailing('hello   ')).toBe('hello');
  });

  it('leaves clean text alone', () => {
    expect(cleanTrailing('Just an answer.')).toBe('Just an answer.');
  });

  it('strips a trailing writer-attribution tag', () => {
    expect(cleanTrailing('Hideo Kojima <IR>')).toBe('Hideo Kojima');
    expect(cleanTrailing('W and Z bosons <EM>')).toBe('W and Z bosons');
    expect(cleanTrailing('shared credit <JC/EM>')).toBe('shared credit');
  });

  it('strips a writer tag left dangling by a section cut (trailing space)', () => {
    // "British Columbia <IR> Double Jump" → SECTION_WORDS cut leaves
    // "British Columbia <IR> " — the tag must still come off.
    expect(cleanTrailing('British Columbia <IR> Double Jump')).toBe('British Columbia');
  });

  it('absorbs a stray quote abutting the writer tag', () => {
    expect(cleanTrailing('Old Hickory <IR>"')).toBe('Old Hickory');
  });

  it('does not touch mid-text angle brackets or comparisons', () => {
    expect(cleanTrailing('a <IR> tag mid-answer stays')).toBe('a <IR> tag mid-answer stays');
    expect(cleanTrailing('prove that x < y')).toBe('prove that x < y');
  });
});
