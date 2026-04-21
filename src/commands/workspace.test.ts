import { describe, expect, it } from 'vitest';
import { parsePositiveInt } from './_shared.js';

// Regression guard for the strict workspace-id parser used by
// `workspace use` and `workspace show --workspace`. `Number.parseInt` alone
// accepts trailing garbage ("36577x" → 36577) which would silently persist
// the wrong id on a typo. Keep the parser strict.
describe('parsePositiveInt', () => {
  it('accepts canonical positive integers', () => {
    expect(parsePositiveInt('36577')).toBe(36577);
    expect(parsePositiveInt('1')).toBe(1);
  });

  it('rejects trailing garbage', () => {
    expect(parsePositiveInt('36577x')).toBeNull();
    expect(parsePositiveInt('36577 ')).toBeNull();
    expect(parsePositiveInt(' 36577')).toBeNull();
  });

  it('rejects zero and negatives', () => {
    expect(parsePositiveInt('0')).toBeNull();
    expect(parsePositiveInt('-1')).toBeNull();
    expect(parsePositiveInt('+1')).toBeNull();
  });

  it('rejects empty and non-digit input', () => {
    expect(parsePositiveInt('')).toBeNull();
    expect(parsePositiveInt('abc')).toBeNull();
    expect(parsePositiveInt('1.5')).toBeNull();
    expect(parsePositiveInt('1e9')).toBeNull();
  });

  it('rejects leading-zero representations', () => {
    expect(parsePositiveInt('01')).toBeNull();
    expect(parsePositiveInt('0001')).toBeNull();
  });

  it('rejects values above Number.MAX_SAFE_INTEGER', () => {
    const tooBig = `${Number.MAX_SAFE_INTEGER}0`;
    expect(parsePositiveInt(tooBig)).toBeNull();
  });
});
