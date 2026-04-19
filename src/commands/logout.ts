import { defineCommand } from 'citty';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { clearSession, sessionPathForDiagnostics } from '../session.js';

export const logoutCommand = defineCommand({
  meta: {
    name: 'logout',
    description: 'Delete the local session file.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON to stdout.',
      default: false,
    },
  },
  async run({ args }) {
    const path = sessionPathForDiagnostics();

    let existed: boolean;
    try {
      const result = await clearSession();
      existed = result.existed;
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

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, status: existed ? 'logged-out' : 'no-session', path })}\n`,
      );
    } else if (existed) {
      process.stdout.write(`Logged out. Session removed from ${path}\n`);
    } else {
      process.stdout.write(`No active session at ${path}.\n`);
    }
    return exitAfterFlush(ExitCode.Ok);
  },
});
