import { defineCommand } from 'citty';
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
    const { existed } = await clearSession();

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, status: existed ? 'logged-out' : 'no-session', path })}\n`,
      );
      return;
    }

    if (existed) {
      process.stdout.write(`Logged out. Session removed from ${path}\n`);
    } else {
      process.stdout.write(`No active session at ${path}.\n`);
    }
  },
});
