import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as backend from './backend.js';
import { FILE_BACKEND } from './backends/file.js';
import { migrateKeychainToFileIfNeeded } from './keychain-migration.js';

function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'aitcc-migration-test-'));
}

describe('migrateKeychainToFileIfNeeded', () => {
  const originalEnv = process.env.AITCC_CREDENTIAL_FILE;
  const originalPlatform = process.platform;
  let dir: string;

  beforeEach(() => {
    dir = freshTmpDir();
    process.env.AITCC_CREDENTIAL_FILE = join(dir, 'credentials.json');
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AITCC_CREDENTIAL_FILE;
    else process.env.AITCC_CREDENTIAL_FILE = originalEnv;
    vi.restoreAllMocks();
    // Restore platform descriptor (non-darwin tests).
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('returns migrated=false on non-darwin platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const result = await migrateKeychainToFileIfNeeded('user@example.com');
    expect(result.migrated).toBe(false);
    expect(result.reason).toMatch(/non-darwin/);
  });

  it('returns migrated=false when `security` command is not found (darwin)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.spyOn(backend, 'runCommand').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    const result = await migrateKeychainToFileIfNeeded('user@example.com');
    expect(result.migrated).toBe(false);
  });

  it('migrates credential from keychain mock to file backend (darwin)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // First call: `security find-generic-password` returns the password.
    // Second call: `security delete-generic-password` succeeds.
    vi.spyOn(backend, 'runCommand')
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'dummy-password-8\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const result = await migrateKeychainToFileIfNeeded('user@example.com');
    expect(result.migrated).toBe(true);

    // Credential should now be in the file backend.
    const stored = await FILE_BACKEND.get('user@example.com');
    expect(stored).toBe('dummy-password-8');

    // A migration notice should have been printed to stderr.
    expect(stderrSpy).toHaveBeenCalled();
    const combined = stderrSpy.mock.calls.flat().join('');
    expect(combined).toMatch(/이전/);
  });
});
