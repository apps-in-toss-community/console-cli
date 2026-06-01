import { mkdtempSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIAL_SERVICE } from '../backend.js';
import { FILE_BACKEND } from './file.js';

function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'aitcc-file-backend-test-'));
}

function makeKey(account: string): string {
  return `${CREDENTIAL_SERVICE}:${account}`;
}

describe('FILE_BACKEND', () => {
  const originalEnv = process.env.AITCC_CREDENTIAL_FILE;
  let dir: string;
  let credFile: string;

  beforeEach(() => {
    dir = freshTmpDir();
    credFile = join(dir, 'credentials.json');
    process.env.AITCC_CREDENTIAL_FILE = credFile;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AITCC_CREDENTIAL_FILE;
    else process.env.AITCC_CREDENTIAL_FILE = originalEnv;
    vi.restoreAllMocks();
  });

  it('set → get round-trip returns the stored password', async () => {
    await FILE_BACKEND.set('user@example.com', 'dummy-password-1');
    const got = await FILE_BACKEND.get('user@example.com');
    expect(got).toBe('dummy-password-1');
  });

  it('get returns null when file does not exist', async () => {
    const got = await FILE_BACKEND.get('nobody@example.com');
    expect(got).toBeNull();
  });

  it('get returns null after clear', async () => {
    await FILE_BACKEND.set('user@example.com', 'dummy-password-2');
    await FILE_BACKEND.clear('user@example.com');
    const got = await FILE_BACKEND.get('user@example.com');
    expect(got).toBeNull();
  });

  it('clear returns existed=true when entry was present', async () => {
    await FILE_BACKEND.set('user@example.com', 'dummy-password-3');
    const result = await FILE_BACKEND.clear('user@example.com');
    expect(result.existed).toBe(true);
  });

  it('clear returns existed=false when entry was absent', async () => {
    const result = await FILE_BACKEND.clear('nobody@example.com');
    expect(result.existed).toBe(false);
  });

  it('unlinks the file when the last entry is cleared', async () => {
    await FILE_BACKEND.set('user@example.com', 'dummy-password-4');
    await FILE_BACKEND.clear('user@example.com');
    // File should not exist.
    await expect(readFile(credFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stores multiple accounts independently', async () => {
    await FILE_BACKEND.set('alice@example.com', 'dummy-pw-alice');
    await FILE_BACKEND.set('bob@example.com', 'dummy-pw-bob');
    expect(await FILE_BACKEND.get('alice@example.com')).toBe('dummy-pw-alice');
    expect(await FILE_BACKEND.get('bob@example.com')).toBe('dummy-pw-bob');
  });

  it('clearing one account leaves others intact', async () => {
    await FILE_BACKEND.set('alice@example.com', 'dummy-pw-alice');
    await FILE_BACKEND.set('bob@example.com', 'dummy-pw-bob');
    await FILE_BACKEND.clear('alice@example.com');
    expect(await FILE_BACKEND.get('alice@example.com')).toBeNull();
    expect(await FILE_BACKEND.get('bob@example.com')).toBe('dummy-pw-bob');
    // File should still exist (bob's entry remains).
    const raw = await readFile(credFile, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    expect(parsed[makeKey('bob@example.com')]).toBe('dummy-pw-bob');
  });

  it('creates the credential file with mode 0600', async () => {
    await FILE_BACKEND.set('user@example.com', 'dummy-password-5');
    if (process.platform !== 'win32') {
      const mode = statSync(credFile).mode & 0o777;
      expect(mode.toString(8)).toBe('600');
    }
  });

  it('AITCC_CREDENTIAL_FILE env override controls the path', async () => {
    const customPath = join(dir, 'custom-creds.json');
    process.env.AITCC_CREDENTIAL_FILE = customPath;
    await FILE_BACKEND.set('user@example.com', 'dummy-password-6');
    const raw = await readFile(customPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    expect(parsed[makeKey('user@example.com')]).toBe('dummy-password-6');
  });

  it('warns to stderr when file permissions are too open (non-fatal)', async () => {
    // Write a credential file with mode 0644.
    await mkdir(dir, { recursive: true });
    const store: Record<string, string> = {};
    store[makeKey('user@example.com')] = 'dummy-password-7';
    await writeFile(credFile, JSON.stringify(store, null, 2));
    if (process.platform !== 'win32') {
      await chmod(credFile, 0o644);
    }

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const got = await FILE_BACKEND.get('user@example.com');

    if (process.platform !== 'win32') {
      expect(stderrSpy).toHaveBeenCalled();
      const combined = stderrSpy.mock.calls.flat().join('');
      expect(combined).toMatch(/expected 0600/);
    }
    // Still returns the value — non-fatal.
    expect(got).toBe('dummy-password-7');
  });
});
