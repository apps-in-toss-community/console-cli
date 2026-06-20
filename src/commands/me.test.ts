import { describe, expect, it } from 'vitest';
import { parseUserTermScope } from './me.js';

// `parseUserTermScope` is the pure arg-validation for `me terms [show|agree]
// --scope`. The command branches (invalid-scope / scope-required / the
// legal-consent gate) all key off its three-way result, so pin it directly.

describe('parseUserTermScope', () => {
  it('returns null when omitted (default base-TOS bucket)', () => {
    expect(parseUserTermScope(undefined)).toBeNull();
    expect(parseUserTermScope('')).toBeNull();
  });

  it('accepts the known scope case-insensitively', () => {
    expect(parseUserTermScope('AI_RISK_USE')).toBe('AI_RISK_USE');
    expect(parseUserTermScope('ai_risk_use')).toBe('AI_RISK_USE');
  });

  it('returns false for an unknown scope so the caller can reject', () => {
    expect(parseUserTermScope('NOPE')).toBe(false);
    expect(parseUserTermScope('TOSS_LOGIN')).toBe(false);
  });
});
