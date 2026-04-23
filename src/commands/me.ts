import { defineCommand } from 'citty';
import { fetchUserTerms, type UserTerm } from '../api/me.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { readSession } from '../session.js';
import { emitFailureFromError, emitJson, emitNotAuthenticated } from './_shared.js';

// --json contract (consumed by agent-plugin):
//
//   me terms:
//     { ok: true, terms: UserTerm[] }                                    exit 0
//     { ok: true, authenticated: false }                                 exit 10
//     { ok: false, reason: 'network-error' | 'api-error', message, ... } exit 11/17
//
// `me` is the user-scoped sibling to `workspace` — anything that describes
// the logged-in account itself (current console-level terms agreements,
// future: profile display name, notification preferences) lives here.

function formatTermLine(t: UserTerm): string {
  const tag = t.isAgreed ? '[agreed]' : '[pending]';
  const req = t.required ? ' required' : '';
  return `  ${tag}${req}  ${t.title}\n    ${t.contentsUrl}\n`;
}

const termsCommand = defineCommand({
  meta: {
    name: 'terms',
    description: 'Show the console-level terms of agreement for the signed-in account.',
  },
  args: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const session = await readSession();
    if (!session) {
      emitNotAuthenticated(args.json);
      return exitAfterFlush(ExitCode.NotAuthenticated);
    }
    try {
      const terms = await fetchUserTerms(session.cookies);
      if (args.json) {
        emitJson({ ok: true, terms });
        return exitAfterFlush(ExitCode.Ok);
      }
      if (terms.length === 0) {
        process.stdout.write('No console-level terms required.\n');
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write('Console account terms:\n');
      for (const t of terms) process.stdout.write(formatTermLine(t));
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

export const meCommand = defineCommand({
  meta: {
    name: 'me',
    description: 'Inspect account-level settings for the signed-in user.',
  },
  subCommands: {
    terms: termsCommand,
  },
});
