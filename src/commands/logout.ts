import { defineCommand } from 'citty';
import { deleteCredentials } from '../auth/credentials.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { clearSession, sessionPathForDiagnostics } from '../session.js';

// `aitcc logout` deletes the local session file. With `--purge` it also
// wipes the saved keychain credentials and the auth-state pointer — the
// "log out and forget me on this machine" intent that used to require a
// separate `aitcc auth clear` invocation.

export const logoutCommand = defineCommand({
  meta: {
    name: 'logout',
    description: 'Delete the local session file (and optionally the saved credentials).',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON to stdout.',
      default: false,
    },
    purge: {
      type: 'boolean',
      description: 'Also delete saved keychain credentials and the auth-state pointer.',
      default: false,
    },
  },
  async run({ args }) {
    const path = sessionPathForDiagnostics();

    let sessionRemoved: boolean;
    try {
      const result = await clearSession();
      sessionRemoved = result.existed;
    } catch (err) {
      const message = (err as Error).message;
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, reason: 'unlink-failed', path, message })}\n`,
        );
      }
      process.stderr.write(`Failed to remove session file at ${path}: ${message}\n`);
      return exitAfterFlush(ExitCode.Generic);
    }

    let credentialsPurged = false;
    let purgeError: string | null = null;
    if (args.purge) {
      try {
        const result = await deleteCredentials();
        credentialsPurged = result.existed;
      } catch (err) {
        // The session is already gone — don't flip the whole command to
        // failure just because the keychain was unhappy. Surface the
        // problem so the user can clean up manually if needed.
        purgeError = (err as Error).message;
      }
    }

    if (args.json) {
      const payload: Record<string, unknown> = {
        ok: true,
        sessionRemoved,
        credentialsPurged,
        path,
      };
      if (purgeError !== null) payload.purgeError = purgeError;
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      if (sessionRemoved) {
        process.stdout.write(`Logged out. Session removed from ${path}\n`);
      } else {
        process.stdout.write(`No active session at ${path}.\n`);
      }
      if (args.purge) {
        if (purgeError !== null) {
          process.stderr.write(`Could not delete saved credentials: ${purgeError}\n`);
        } else if (credentialsPurged) {
          process.stdout.write('Saved credentials deleted from the OS keychain.\n');
        } else {
          process.stdout.write('No saved credentials to delete.\n');
        }
      }
    }
    return exitAfterFlush(ExitCode.Ok);
  },
});
