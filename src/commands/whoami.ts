import { defineCommand } from 'citty';
import { ExitCode } from '../exit.js';
import { readSessionSummary, sessionPathForDiagnostics } from '../session.js';

export const whoamiCommand = defineCommand({
  meta: {
    name: 'whoami',
    description: 'Show the currently authenticated user from the local session.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON to stdout.',
      default: false,
    },
  },
  async run({ args }) {
    const summary = await readSessionSummary();

    if (!summary) {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ authenticated: false })}\n`);
      } else {
        process.stderr.write('Not logged in. Run `ait-console login` to start a session.\n');
        process.stderr.write(`Session file checked: ${sessionPathForDiagnostics()}\n`);
      }
      process.exit(ExitCode.NotAuthenticated);
    }

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({
          authenticated: true,
          user: summary.user,
          capturedAt: summary.capturedAt,
        })}\n`,
      );
      return;
    }

    const label = summary.user.displayName
      ? `${summary.user.displayName} <${summary.user.email}>`
      : summary.user.email;
    process.stdout.write(`Logged in as ${label}\n`);
    process.stdout.write(`Session captured: ${summary.capturedAt}\n`);
  },
});
