import { mkdtempSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authStateFilePath } from '../paths.js';
import {
  type CredentialBackend,
  CredentialBackendCommandError,
  CredentialBackendUnsupportedError,
  redactStderr,
} from './backend.js';
import {
  deleteCredentials,
  loadCredentials,
  resolveBackend,
  saveCredentials,
} from './credentials.js';

function freshConfigRoot(): string {
  return mkdtempSync(join(tmpdir(), 'aitcc-cred-test-'));
}

class InMemoryBackend implements CredentialBackend {
  readonly name = 'in-memory';
  readonly store = new Map<string, string>();
  // Per-call counters help assert no-op semantics.
  getCalls = 0;
  setCalls = 0;
  clearCalls = 0;

  async get(account: string): Promise<string | null> {
    this.getCalls += 1;
    return this.store.get(account) ?? null;
  }
  async set(account: string, password: string): Promise<void> {
    this.setCalls += 1;
    this.store.set(account, password);
  }
  async clear(account: string): Promise<{ existed: boolean }> {
    this.clearCalls += 1;
    const existed = this.store.delete(account);
    return { existed };
  }
}

describe('credentials — env source', () => {
  // We poke `opts.env` directly so these tests don't pollute process.env.
  it('returns kind=env when both AITCC_EMAIL and AITCC_PASSWORD are set', async () => {
    const backend = new InMemoryBackend();
    const got = await loadCredentials({
      override: backend,
      env: { AITCC_EMAIL: 'ci@example.com', AITCC_PASSWORD: 'ci-secret' },
    });
    expect(got).toEqual({ kind: 'env', email: 'ci@example.com', password: 'ci-secret' });
    // The env path must not even talk to the backend.
    expect(backend.getCalls).toBe(0);
  });

  it('falls through to keychain when only one env var is set', async () => {
    const backend = new InMemoryBackend();
    const got = await loadCredentials({
      override: backend,
      env: { AITCC_EMAIL: 'ci@example.com' }, // password missing
    });
    expect(got).toBeNull();
  });
});

describe('credentials — keychain source', () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let root: string;

  beforeEach(() => {
    root = freshConfigRoot();
    process.env.XDG_CONFIG_HOME = root;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  });

  it('returns null when no auth-state pointer exists', async () => {
    const backend = new InMemoryBackend();
    expect(await loadCredentials({ override: backend, env: {} })).toBeNull();
    expect(backend.getCalls).toBe(0);
  });

  it('saveCredentials creates a new entry, records status=created', async () => {
    const backend = new InMemoryBackend();
    const result = await saveCredentials('a@example.com', 'pw1', { override: backend });
    expect(result.status).toBe('created');
    expect(backend.store.get('a@example.com')).toBe('pw1');

    // auth-state pointer should be written 0600 with the active email.
    const statePath = authStateFilePath();
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as { schemaVersion: number; activeEmail: string };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.activeEmail).toBe('a@example.com');
    if (process.platform !== 'win32') {
      expect((statSync(statePath).mode & 0o777).toString(8)).toBe('600');
    }
  });

  it('loadCredentials returns kind=keychain after save', async () => {
    const backend = new InMemoryBackend();
    await saveCredentials('a@example.com', 'pw1', { override: backend });
    const got = await loadCredentials({ override: backend, env: {} });
    expect(got).toEqual({ kind: 'keychain', email: 'a@example.com', password: 'pw1' });
  });

  it('saveCredentials with same email + same password is unchanged (no-op write)', async () => {
    const backend = new InMemoryBackend();
    await saveCredentials('a@example.com', 'pw1', { override: backend });
    const setCallsBefore = backend.setCalls;
    const result = await saveCredentials('a@example.com', 'pw1', { override: backend });
    expect(result.status).toBe('unchanged');
    // No keychain write — important to avoid OS keychain prompts on rerun.
    expect(backend.setCalls).toBe(setCallsBefore);
  });

  it('saveCredentials with same email + different password reports updated', async () => {
    const backend = new InMemoryBackend();
    await saveCredentials('a@example.com', 'pw1', { override: backend });
    const result = await saveCredentials('a@example.com', 'pw2', { override: backend });
    expect(result.status).toBe('updated');
    expect(backend.store.get('a@example.com')).toBe('pw2');
  });

  it('saveCredentials switching emails clears the previous keychain entry', async () => {
    const backend = new InMemoryBackend();
    await saveCredentials('old@example.com', 'pw-old', { override: backend });
    expect(backend.store.has('old@example.com')).toBe(true);

    const result = await saveCredentials('new@example.com', 'pw-new', { override: backend });
    expect(result.status).toBe('updated');
    expect(backend.store.has('old@example.com')).toBe(false);
    expect(backend.store.get('new@example.com')).toBe('pw-new');

    // Pointer should track the new email.
    const got = await loadCredentials({ override: backend, env: {} });
    expect(got?.email).toBe('new@example.com');
  });

  it('loadCredentials returns null when pointer dangles (keychain entry is missing)', async () => {
    const backend = new InMemoryBackend();
    await saveCredentials('a@example.com', 'pw1', { override: backend });
    // Simulate the keychain entry being wiped out-of-band.
    backend.store.clear();
    const got = await loadCredentials({ override: backend, env: {} });
    expect(got).toBeNull();
  });

  it('deleteCredentials removes both keychain entry and pointer', async () => {
    const backend = new InMemoryBackend();
    await saveCredentials('a@example.com', 'pw1', { override: backend });
    const first = await deleteCredentials({ override: backend });
    expect(first.existed).toBe(true);
    expect(backend.store.has('a@example.com')).toBe(false);

    // Idempotent on second call.
    const second = await deleteCredentials({ override: backend });
    expect(second.existed).toBe(false);

    expect(await loadCredentials({ override: backend, env: {} })).toBeNull();
  });

  it('saveCredentials rejects empty email or empty password', async () => {
    const backend = new InMemoryBackend();
    await expect(saveCredentials('', 'pw', { override: backend })).rejects.toThrow(/email/);
    await expect(saveCredentials('a@example.com', '', { override: backend })).rejects.toThrow(
      /password/,
    );
  });
});

describe('credentials — backend resolution', () => {
  it('resolveBackend returns the override when supplied', () => {
    const backend = new InMemoryBackend();
    expect(resolveBackend({ override: backend })).toBe(backend);
  });

  it('resolveBackend throws CredentialBackendUnsupportedError for unknown platforms', () => {
    expect(() => resolveBackend({ platform: 'aix' })).toThrow(CredentialBackendUnsupportedError);
  });

  it('resolveBackend picks the macOS, Linux, and Windows backends by name', () => {
    expect(resolveBackend({ platform: 'darwin' }).name).toBe('macos-keychain');
    expect(resolveBackend({ platform: 'linux' }).name).toBe('libsecret');
    expect(resolveBackend({ platform: 'win32' }).name).toBe('windows-credential-manager');
  });
});

describe('credentials — error redaction', () => {
  it('redactStderr returns a placeholder for empty stderr', () => {
    expect(redactStderr('')).toBe('<no stderr>');
    expect(redactStderr('   \n')).toBe('<no stderr>');
  });

  it('redactStderr passes short stderr through unchanged', () => {
    expect(redactStderr('boom')).toBe('boom');
  });

  it('redactStderr truncates long stderr to keep accidental secret leaks bounded', () => {
    const long = 'x'.repeat(500);
    const got = redactStderr(long);
    expect(got.length).toBeLessThan(long.length);
    expect(got).toMatch(/<truncated>$/);
  });

  it('CredentialBackendCommandError surfaces command + exit code without raw stderr', () => {
    const err = new CredentialBackendCommandError(
      'security add-generic-password',
      1,
      '<no stderr>',
    );
    expect(err.message).toContain('security add-generic-password');
    expect(err.message).toContain('exit=1');
    expect(err.name).toBe('CredentialBackendCommandError');
  });
});
