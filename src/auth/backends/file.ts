import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configDir } from '../../paths.js';
import { CREDENTIAL_SERVICE, type CredentialBackend } from '../backend.js';

// Default path for the credential file. Override with AITCC_CREDENTIAL_FILE
// env var — useful for tests and for non-standard install paths.
function credentialFilePath(): string {
  const override = process.env.AITCC_CREDENTIAL_FILE;
  if (override && override.length > 0) return override;
  return join(configDir(), 'credentials.json');
}

// Key format: "<service>:<account>" — stable across versions. The service
// component is CREDENTIAL_SERVICE, matching the keychain backends.
function makeKey(account: string): string {
  return `${CREDENTIAL_SERVICE}:${account}`;
}

type CredentialStore = Record<string, string>;

async function readStore(filePath: string): Promise<CredentialStore | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  // Warn if the file permissions are too open.
  try {
    const s = await stat(filePath);
    const mode = s.mode & 0o777;
    if (mode !== 0o600) {
      process.stderr.write(
        `Warning: credential file ${filePath} has permissions ${mode.toString(8)} — expected 0600.\n` +
          `  Run: chmod 600 ${filePath}\n`,
      );
    }
  } catch {
    // Stat failure is non-fatal — the file was readable, proceed.
  }
  try {
    return JSON.parse(raw) as CredentialStore;
  } catch {
    return null;
  }
}

async function writeStore(filePath: string, store: CredentialStore): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(filePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  // Best-effort chmod — some file systems don't honour the mode on writeFile.
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Non-fatal: Windows or exotic FS.
  }
}

export const FILE_BACKEND: CredentialBackend = {
  name: 'file',
  async get(account) {
    const filePath = credentialFilePath();
    const store = await readStore(filePath);
    if (store === null) return null;
    const value = store[makeKey(account)];
    return typeof value === 'string' && value.length > 0 ? value : null;
  },
  async set(account, password) {
    const filePath = credentialFilePath();
    const store = (await readStore(filePath)) ?? {};
    store[makeKey(account)] = password;
    await writeStore(filePath, store);
  },
  async clear(account) {
    const filePath = credentialFilePath();
    const store = await readStore(filePath);
    if (store === null) return { existed: false };
    const key = makeKey(account);
    const existed = key in store;
    if (!existed) return { existed: false };
    delete store[key];
    if (Object.keys(store).length === 0) {
      // Remove the file entirely when the store is empty.
      try {
        await unlink(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    } else {
      await writeStore(filePath, store);
    }
    return { existed: true };
  },
};
