import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasAitTokenProfile, saveAitTokenProfile } from './ait-token-profile.js';

// Use a temp directory for each test so we never touch ~/.ait/credentials.
// The module reads _AIT_CREDENTIALS_PATH_OVERRIDE from process.env.
let tempDir: string;
let credentialsPath: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `ait-profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  credentialsPath = join(tempDir, 'credentials');
  process.env._AIT_CREDENTIALS_PATH_OVERRIDE = credentialsPath;
});

afterEach(() => {
  delete process.env._AIT_CREDENTIALS_PATH_OVERRIDE;
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('saveAitTokenProfile', () => {
  it('creates ~/.ait/credentials with the profile entry when the file does not exist', () => {
    const result = saveAitTokenProfile('ci-deploy', 'dummy-key-value');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.method).toBe('direct');
    expect(result.profile).toBe('ci-deploy');

    const written = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    expect(written['ci-deploy']).toBe('dummy-key-value');
  });

  it('merges into an existing credentials file without overwriting other profiles', () => {
    mkdirSync(tempDir, { recursive: true });
    // Pre-populate with an existing profile.
    const existing = { 'other-profile': 'other-key' };
    writeFileSync(credentialsPath, JSON.stringify(existing, null, 2), { encoding: 'utf8' });

    saveAitTokenProfile('new-profile', 'new-key');

    const written = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    // Both profiles must be present.
    expect(written['other-profile']).toBe('other-key');
    expect(written['new-profile']).toBe('new-key');
  });

  it('overwrites an existing profile entry when called with the same name', () => {
    saveAitTokenProfile('my-profile', 'old-key');
    saveAitTokenProfile('my-profile', 'new-key');

    const written = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    expect(written['my-profile']).toBe('new-key');
  });

  it('creates the parent directory if it does not exist', () => {
    // tempDir itself does not exist yet (beforeEach never calls mkdirSync).
    expect(existsSync(tempDir)).toBe(false);

    const result = saveAitTokenProfile('test', 'some-key');
    expect(result.ok).toBe(true);
    expect(existsSync(credentialsPath)).toBe(true);
  });

  it('returns ok:false with a non-secret detail when write fails', () => {
    // Point the override at an unwritable path on a read-only root.
    // Simulate by using a path under a file (not a directory).
    const filePath = join(tempDir, 'not-a-dir');
    mkdirSync(tempDir, { recursive: true });
    // Create a file where the directory would be so mkdir/writeFile fail.
    writeFileSync(filePath, 'blocker', 'utf8');
    process.env._AIT_CREDENTIALS_PATH_OVERRIDE = join(filePath, 'credentials');

    const result = saveAitTokenProfile('profile', 'some-key');
    // Direct write will fail; spawn fallback also fails because 'ait' is not
    // a real command in this test context.
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // The detail must NOT contain the key.
    expect(result.detail).not.toContain('some-key');
    // Reason must be one of the failure variants.
    expect(['write-failed', 'spawn-failed']).toContain(result.reason);
  });

  it('does not include the plaintext key in the failure detail message', () => {
    // Override to a path whose parent is a file (not a directory), so both
    // mkdirSync and writeFileSync will fail.
    const blocker = join(tempDir, 'blocker');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(blocker, '', 'utf8');
    process.env._AIT_CREDENTIALS_PATH_OVERRIDE = join(blocker, 'credentials');

    const SECRET = 'super-secret-deploy-key-9999';
    const result = saveAitTokenProfile('p', SECRET);
    if (result.ok) return; // If somehow it succeeded, skip the assertion.

    expect(result.detail).not.toContain(SECRET);
  });
});

describe('hasAitTokenProfile', () => {
  it('returns false when the credentials file does not exist', () => {
    expect(hasAitTokenProfile('anything')).toBe(false);
  });

  it('returns true for a profile that was saved', () => {
    saveAitTokenProfile('saved', 'some-key');
    expect(hasAitTokenProfile('saved')).toBe(true);
  });

  it('returns false for a profile that was not saved', () => {
    saveAitTokenProfile('other', 'some-key');
    expect(hasAitTokenProfile('missing')).toBe(false);
  });
});
