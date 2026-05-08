import { describe, expect, it } from 'vitest';
import { formatExpiry, parseAppsFlag, validateKeyName } from './keys.js';

// Console UI dialog rules captured from `static/index.ZsA5htf8.js` (`he`):
// the field is gated on length 1..16 and the placeholder rejects whitespace
// + Korean + special chars. We mirror those locally so a typo fails before
// the network round-trip.
describe('validateKeyName', () => {
  it('accepts canonical labels', () => {
    expect(validateKeyName('ci-deploy')).toBeNull();
    expect(validateKeyName('CI_2')).toBeNull();
    expect(validateKeyName('a')).toBeNull();
    expect(validateKeyName('1234567890123456')).toBeNull(); // exactly 16
  });

  it('rejects empty', () => {
    expect(validateKeyName('')).toBe('too-short');
  });

  it('rejects > 16 chars', () => {
    expect(validateKeyName('12345678901234567')).toBe('too-long');
  });

  it('rejects whitespace, Korean, and special chars', () => {
    expect(validateKeyName('ci deploy')).toBe('bad-chars');
    expect(validateKeyName('한글키')).toBe('bad-chars');
    expect(validateKeyName('ci.deploy')).toBe('bad-chars');
    expect(validateKeyName('ci@deploy')).toBe('bad-chars');
  });
});

describe('parseAppsFlag', () => {
  it('splits a comma-separated list and trims whitespace', () => {
    expect(parseAppsFlag('foo,bar,baz')).toEqual({ ok: true, slugs: ['foo', 'bar', 'baz'] });
    expect(parseAppsFlag('  foo , bar ,baz ')).toEqual({
      ok: true,
      slugs: ['foo', 'bar', 'baz'],
    });
  });

  it('rejects an all-empty input as `empty` (the user should drop the flag)', () => {
    expect(parseAppsFlag('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseAppsFlag(',,')).toEqual({ ok: false, reason: 'empty' });
  });

  it('flags slugs that violate the kebab-case appName regex', () => {
    const r = parseAppsFlag('valid-slug,Invalid_Slug,123nope');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid');
    expect(r.bad).toEqual(['Invalid_Slug', '123nope']);
  });
});

describe('formatExpiry', () => {
  // The console UI renders countdown badges (`D-N` / `만료`) by comparing
  // `expireTs` to `Date.now()` at floor-day resolution. Mirror that so
  // `keys ls` matches what users see in the UI.
  const now = Date.parse('2026-05-08T00:00:00Z');

  it('returns blank when no expiry is known', () => {
    expect(formatExpiry(undefined, now)).toBe('');
  });

  it('returns D-N for future expiries (floor of full days remaining)', () => {
    const tenDays = now + 10 * 86_400_000;
    expect(formatExpiry(tenDays, now)).toBe('D-10');
    // Just under 10 full days (mid-day) still floors to D-9 — matches UI.
    expect(formatExpiry(tenDays - 3_600_000, now)).toBe('D-9');
  });

  it('returns "expired" once the timestamp is in the past', () => {
    expect(formatExpiry(now - 1, now)).toBe('expired');
  });

  // D-0 boundary: anything from "right now" up to "just under one full day
  // remaining" is the same UI bucket. Pin both ends so a future refactor
  // that swaps `Math.floor` for `Math.ceil` (or shifts the < 0 cutoff) is
  // caught — the UI's countdown badge depends on this exact behaviour.
  it('returns D-0 for the same-day window (now .. now + <1 day)', () => {
    expect(formatExpiry(now, now)).toBe('D-0');
    expect(formatExpiry(now + 1, now)).toBe('D-0');
    expect(formatExpiry(now + 86_400_000 - 1, now)).toBe('D-0');
  });
});
