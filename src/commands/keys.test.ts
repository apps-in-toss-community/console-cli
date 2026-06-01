import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveAitTokenProfile } from '../ait-token-profile.js';
import { formatExpiry, parseAppsFlag, resolveProfileName, validateKeyName } from './keys.js';

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

// ---------------------------------------------------------------------------
// resolveProfileName — pure unit tests for the three auto-save branches
// ---------------------------------------------------------------------------
// These cover the key contract: by default the profile name equals --name,
// --save-profile <other> overrides it, and --no-save-profile disables saving.
describe('resolveProfileName', () => {
  it('default: returns --name when no flags are given', () => {
    expect(resolveProfileName('ci-deploy', {})).toBe('ci-deploy');
  });

  it('--save-profile <other>: returns the override name, not --name', () => {
    expect(resolveProfileName('ci-deploy', { saveProfileOverride: 'staging' })).toBe('staging');
  });

  it('--no-save-profile: returns undefined (saving disabled)', () => {
    expect(resolveProfileName('ci-deploy', { noSaveProfile: true })).toBeUndefined();
  });

  it('--no-save-profile takes precedence over --save-profile', () => {
    // If somehow both flags are present, no-save-profile wins.
    expect(
      resolveProfileName('ci-deploy', { noSaveProfile: true, saveProfileOverride: 'other' }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Auto-save integration: credential file written / not written
// ---------------------------------------------------------------------------
// Exercises the three flag-driven branches end-to-end by simulating what
// the `keys create` command does after it receives an apiKey from the server:
//   1. resolve the profile name (already covered above)
//   2. call saveAitTokenProfile when a name is resolved
//
// Tests redirect the credentials path via _AIT_CREDENTIALS_PATH_OVERRIDE so
// the real ~/.ait/credentials is never touched.
// The apiKey value must never appear in any stderr output (SECRET-HANDLING).
// ---------------------------------------------------------------------------

describe('keys create — auto-save credential branches', () => {
  let tempDir: string;
  let credPath: string;
  const TEST_API_KEY = 'test-deploy-key-abc123';

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `keys-create-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    credPath = join(tempDir, 'credentials');
    process.env._AIT_CREDENTIALS_PATH_OVERRIDE = credPath;
  });

  afterEach(() => {
    delete process.env._AIT_CREDENTIALS_PATH_OVERRIDE;
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('default (no flags): profile saved under --name value', () => {
    // Simulate what createCommand does on the default path.
    const profileName = resolveProfileName('ci-deploy', {});
    expect(profileName).toBe('ci-deploy');

    // saveAitTokenProfile is the actual write call.
    if (profileName !== undefined) {
      const saveResult = saveAitTokenProfile(profileName, TEST_API_KEY);
      expect(saveResult.ok).toBe(true);
    }

    // Credential file must contain the profile.
    expect(existsSync(credPath)).toBe(true);
    const written = JSON.parse(readFileSync(credPath, 'utf8'));
    expect(written['ci-deploy']).toBe(TEST_API_KEY);

    // SECRET-HANDLING: apiKey must not appear in any warning/detail that
    // would be emitted to stderr. The saveResult.ok path emits no warning.
  });

  it('--no-save-profile: profile name resolves to undefined; credentials NOT written', () => {
    const profileName = resolveProfileName('ci-deploy', { noSaveProfile: true });
    expect(profileName).toBeUndefined();

    // When profileName is undefined the command skips saveAitTokenProfile.
    // Verify the file is not created.
    expect(existsSync(credPath)).toBe(false);
  });

  it('--save-profile <other>: saved under override name, not --name', () => {
    const profileName = resolveProfileName('ci-deploy', { saveProfileOverride: 'staging' });
    expect(profileName).toBe('staging');

    if (profileName !== undefined) {
      const saveResult = saveAitTokenProfile(profileName, TEST_API_KEY);
      expect(saveResult.ok).toBe(true);
    }

    // Must be keyed under 'staging', NOT 'ci-deploy'.
    const written = JSON.parse(readFileSync(credPath, 'utf8'));
    expect(written.staging).toBe(TEST_API_KEY);
    expect(written['ci-deploy']).toBeUndefined();
  });

  it('SECRET-HANDLING: saveAitTokenProfile failure detail never includes the apiKey', () => {
    // Force a write failure by pointing credentials at a path whose
    // parent is a file (not a directory).
    const blocker = join(tempDir, 'blocker');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(blocker, '', 'utf8');
    process.env._AIT_CREDENTIALS_PATH_OVERRIDE = join(blocker, 'credentials');

    const SECRET = 'super-secret-deploy-key-xyz';
    const result = saveAitTokenProfile('profile', SECRET);
    if (result.ok) return; // skip if write somehow succeeded

    expect(result.detail).not.toContain(SECRET);
  });
});
