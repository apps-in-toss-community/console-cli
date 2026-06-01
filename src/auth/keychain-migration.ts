import {
  CREDENTIAL_SERVICE,
  isCommandNotFound,
  runCommand,
  stripTrailingNewline,
} from './backend.js';
import { FILE_BACKEND } from './backends/file.js';

// One-shot migration: if the user previously saved credentials to the macOS
// OS keychain (via `--save=keychain` in aitcc <=0.1.x), this shim reads
// them out on first run, writes them to the file backend, and deletes the
// keychain entry so the store is clean.
//
// This shim is intentionally isolated: remove the `migrateKeychainToFile`
// import in `loadCredentials` in a future minor to retire it. The shim is
// darwin-only for now; Linux libsecret and Windows Credential Manager
// migration can be added as follow-up patches if usage data warrants it.
//
// SECURITY: the password value must NEVER be written to stdout/stderr/logs.

export interface MigrationResult {
  readonly migrated: boolean;
  readonly reason?: string;
}

/**
 * Attempt a one-time migration of a macOS Keychain credential entry to the
 * file backend. Silent on failure — the caller is expected to fall through
 * to "no credentials found" if migration is not possible.
 *
 * @param email  The email (= keychain account) to look up.
 */
export async function migrateKeychainToFileIfNeeded(email: string): Promise<MigrationResult> {
  if (process.platform !== 'darwin') {
    return { migrated: false, reason: 'non-darwin platform — skipping' };
  }

  // Read from macOS Keychain.
  let result: Awaited<ReturnType<typeof runCommand>>;
  try {
    result = await runCommand('security', {
      args: ['find-generic-password', '-s', CREDENTIAL_SERVICE, '-a', email, '-w'],
    });
  } catch (err) {
    if (isCommandNotFound(err)) {
      return { migrated: false, reason: '`security` not found' };
    }
    return { migrated: false, reason: (err as Error).message };
  }

  if (result.exitCode !== 0) {
    // errSecItemNotFound (44) or any other failure — nothing to migrate.
    return { migrated: false, reason: `security exited ${result.exitCode ?? 'null'}` };
  }

  const password = stripTrailingNewline(result.stdout);
  if (password.length === 0) {
    return { migrated: false, reason: 'empty password in keychain entry' };
  }

  // Write to the file backend.
  try {
    await FILE_BACKEND.set(email, password);
  } catch (err) {
    return { migrated: false, reason: `file write failed: ${(err as Error).message}` };
  }

  // Best-effort cleanup of the keychain entry — non-fatal if it fails.
  try {
    await runCommand('security', {
      args: ['delete-generic-password', '-s', CREDENTIAL_SERVICE, '-a', email],
    });
  } catch {
    // Ignore — the file backend already has the credential.
  }

  process.stderr.write(
    `기존 keychain 자격증명을 ~/.config/aitcc/credentials.json으로 이전했습니다.\n`,
  );
  return { migrated: true };
}
