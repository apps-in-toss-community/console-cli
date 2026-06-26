import { defineCommand } from 'citty';
import {
  agreeUserTerms,
  fetchUserTerms,
  USER_TERM_SCOPES,
  type UserTerm,
  type UserTermScope,
} from '../api/me.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { readSession } from '../session.js';
import {
  emitFailureFromError,
  emitJson,
  emitNotAuthenticated,
  withReauthRetry,
} from './_shared.js';

// --json contract (consumed by agent-plugin):
//
//   me terms [show] [--scope AI_RISK_USE]:
//     { ok: true, scope: null, terms: UserTerm[] }            exit 0  (default — base console TOS)
//     { ok: true, scope: 'AI_RISK_USE', terms: UserTerm[] }   exit 0  (scope bucket)
//     { ok: false, reason: 'invalid-scope', allowed: SCOPES[] } exit 2
//     { ok: true, authenticated: false }                       exit 10
//     { ok: false, reason: 'network-error' | 'api-error', message, ... } exit 11/17
//
//   me terms agree --scope AI_RISK_USE [--yes]:
//     { ok: true, scope, agreed: AgreedUserTerm[], unchanged: AgreedUserTerm[] }  exit 0
//     { ok: false, reason: 'confirmation-required', scope, pending: AgreedUserTerm[] } exit 2
//       (required term(s) pending and neither --yes nor an interactive TTY confirm)
//     { ok: false, reason: 'invalid-scope', allowed: SCOPES[] }                    exit 2
//     { ok: false, reason: 'scope-required', allowed: SCOPES[] }                   exit 2
//       (agree always targets a specific scope; the default TOS bucket has no
//        CLI agree path — it is accepted during sign-up in the browser)
//
//   `AgreedUserTerm = { termsId, revisionId, title }`. `agreed` lists what
//   this run flipped pending → agreed; `unchanged` lists terms already
//   agreed at fetch time (idempotent skip — server is NOT idempotent on
//   re-submit, so we filter client-side).
//
// `me` is the user-scoped sibling to `workspace` — anything that describes
// the logged-in account itself. The AI-risk usage terms (`AI_RISK_USE`)
// are account-level: agreeing once unblocks errorCode 5010 across every
// workspace, which is why they live here and not under `workspace terms`.
//
// Legal-consent gate: `terms agree` shows each term's title + contentsUrl
// and submits only after explicit confirmation. Under `--json` (or any
// non-TTY pipe) the confirmation must be the explicit `--yes` flag — we
// never auto-agree to a legal document on the user's behalf.

function formatTermLine(t: UserTerm): string {
  const tag = t.isAgreed ? '[agreed]' : '[pending]';
  const req = t.required ? ' required' : '';
  return `  ${tag}${req}  ${t.title}\n    ${t.contentsUrl}\n`;
}

// Record surfaced in the `agree` JSON payload (and the confirmation gate).
// Narrower than UserTerm — the consumer only needs to correlate the term
// and render its title.
export interface AgreedUserTerm {
  readonly termsId: number;
  readonly revisionId: number;
  readonly title: string;
}

function toAgreed(t: UserTerm): AgreedUserTerm {
  return { termsId: t.termsId, revisionId: t.revisionId, title: t.title };
}

// Parse the `--scope` flag (case-insensitive) into a known scope, or null
// when omitted. Returns `false` for an unknown value so the caller can
// emit the invalid-scope branch. Exported for unit testing.
export function parseUserTermScope(raw: string | undefined): UserTermScope | null | false {
  if (raw === undefined || raw === '') return null;
  const upper = raw.toUpperCase();
  if ((USER_TERM_SCOPES as readonly string[]).includes(upper)) {
    return upper as UserTermScope;
  }
  return false;
}

const termsShowCommand = defineCommand({
  meta: {
    name: 'show',
    description:
      'Show the console-level terms of agreement for the signed-in account. ' +
      'Pass --scope AI_RISK_USE for the AI-risk usage terms (gates errorCode 5010).',
  },
  args: {
    scope: {
      type: 'string',
      description: `Account-level terms bucket: ${USER_TERM_SCOPES.join(' | ')}. Omit for the base console TOS.`,
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const scope = parseUserTermScope(args.scope !== undefined ? String(args.scope) : undefined);
    if (scope === false) {
      const message = `--scope must be one of: ${USER_TERM_SCOPES.join(', ')}`;
      if (args.json)
        emitJson({ ok: false, reason: 'invalid-scope', allowed: [...USER_TERM_SCOPES] });
      else process.stderr.write(`${message}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }

    const session = await readSession();
    if (!session) {
      emitNotAuthenticated(args.json);
      return exitAfterFlush(ExitCode.NotAuthenticated);
    }
    try {
      const terms = await withReauthRetry(args.json, session, (s) =>
        fetchUserTerms(s.cookies, {
          ...(scope !== null ? { scope } : {}),
        }),
      );
      if (args.json) {
        emitJson({ ok: true, scope, terms });
        return exitAfterFlush(ExitCode.Ok);
      }
      if (terms.length === 0) {
        process.stdout.write(
          scope === null ? 'No console-level terms required.\n' : `No ${scope} terms required.\n`,
        );
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(scope === null ? 'Console account terms:\n' : `${scope} terms:\n`);
      for (const t of terms) process.stdout.write(formatTermLine(t));
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

// Read a single y/N line from the TTY. Resolves to true only on an
// explicit "y"/"yes" (case-insensitive). Used to gate the legal consent
// when running interactively without --yes. Never invoked under --json
// (the caller routes those through the explicit --yes flag instead).
async function confirmTty(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, resolve);
    });
    const norm = answer.trim().toLowerCase();
    return norm === 'y' || norm === 'yes';
  } finally {
    rl.close();
  }
}

// Print the pending terms and ask for confirmation on the TTY. Returns the
// user's y/N answer. Kept close to the prompt copy and the legal documents
// it presents.
async function confirmAgreement(
  scope: UserTermScope,
  pending: readonly UserTerm[],
): Promise<boolean> {
  process.stderr.write(`The following ${scope} term(s) require your agreement:\n`);
  for (const t of pending) {
    const req = t.required ? ' (필수)' : ' (선택)';
    process.stderr.write(`  -${req} ${t.title}\n      ${t.contentsUrl}\n`);
  }
  process.stderr.write('\nThis is a legal agreement. Review the link(s) above before agreeing.\n');
  return confirmTty('Agree to these terms? [y/N] ');
}

const termsAgreeCommand = defineCommand({
  meta: {
    name: 'agree',
    description:
      'Agree to account-level terms (e.g. --scope AI_RISK_USE). Shows each term and requires ' +
      'explicit confirmation (--yes, or an interactive y/N) before submitting — this is a legal consent.',
  },
  args: {
    scope: {
      type: 'string',
      description: `Terms bucket to agree to (required): ${USER_TERM_SCOPES.join(' | ')}.`,
    },
    yes: {
      type: 'boolean',
      default: false,
      description:
        'Confirm the legal agreement without an interactive prompt. Required under --json / non-TTY.',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const scope = parseUserTermScope(args.scope !== undefined ? String(args.scope) : undefined);
    if (scope === false) {
      const message = `--scope must be one of: ${USER_TERM_SCOPES.join(', ')}`;
      if (args.json)
        emitJson({ ok: false, reason: 'invalid-scope', allowed: [...USER_TERM_SCOPES] });
      else process.stderr.write(`${message}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }
    // Agree always targets a concrete scope. The base console TOS bucket
    // is accepted during browser sign-up; there is no CLI agree path for it.
    if (scope === null) {
      const message = `--scope is required for agree (one of: ${USER_TERM_SCOPES.join(', ')}).`;
      if (args.json)
        emitJson({ ok: false, reason: 'scope-required', allowed: [...USER_TERM_SCOPES] });
      else process.stderr.write(`${message}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }

    const session = await readSession();
    if (!session) {
      emitNotAuthenticated(args.json);
      return exitAfterFlush(ExitCode.NotAuthenticated);
    }

    try {
      const terms = await fetchUserTerms(session.cookies, { scope });
      const unchanged = terms.filter((t) => t.isAgreed).map(toAgreed);
      const pending = terms.filter((t) => !t.isAgreed);

      if (pending.length === 0) {
        if (args.json) {
          emitJson({ ok: true, scope, agreed: [], unchanged });
          return exitAfterFlush(ExitCode.Ok);
        }
        process.stdout.write(
          unchanged.length === 0
            ? `No ${scope} terms to agree to.\n`
            : `Already agreed to ${unchanged.length} ${scope} term(s) — nothing to do.\n`,
        );
        return exitAfterFlush(ExitCode.Ok);
      }

      // Legal-consent gate. Always surface the documents first. Under
      // --json or a non-TTY we require the explicit --yes flag; in an
      // interactive TTY we fall back to a y/N prompt. We never auto-agree.
      const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
      const confirmed =
        args.yes === true ||
        (!args.json && interactive && (await confirmAgreement(scope, pending)));

      if (!confirmed) {
        const pendingAgreed = pending.map(toAgreed);
        if (args.json) {
          emitJson({ ok: false, reason: 'confirmation-required', scope, pending: pendingAgreed });
        } else if (!interactive) {
          // We never prompted (non-TTY) — point the user at --yes.
          process.stderr.write(
            'This is a legal agreement. Re-run with --yes to confirm (review the link(s) first via `aitcc me terms --scope ' +
              `${scope}\`).\n`,
          );
        } else {
          // Interactive: the user answered "no" at the prompt.
          process.stderr.write('Aborted — no consent given.\n');
        }
        return exitAfterFlush(ExitCode.Usage);
      }

      await agreeUserTerms(
        pending.map((t) => ({ termsId: t.termsId, revisionId: t.revisionId })),
        session.cookies,
      );
      const agreed = pending.map(toAgreed);

      if (args.json) {
        emitJson({ ok: true, scope, agreed, unchanged });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`✓ Agreed to ${agreed.length} ${scope} term(s).\n`);
      for (const a of agreed) process.stdout.write(`    - ${a.title}\n`);
      if (unchanged.length > 0) {
        process.stdout.write(`(skipped ${unchanged.length} already-agreed term(s))\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const termsCommand = defineCommand({
  meta: {
    name: 'terms',
    description:
      'Show or agree to console account-level terms. Bare `me terms` shows the base TOS; ' +
      '`--scope AI_RISK_USE` / `agree --scope AI_RISK_USE` handle the AI-risk usage terms (errorCode 5010).',
  },
  // Routing scaffolding so `me terms --scope AI_RISK_USE` (bare → show)
  // parses the value flag instead of reading it as a subcommand name. The
  // parent never reads these; runCommand re-parses inside the subcommand.
  args: {
    scope: { type: 'string', description: 'Forwarded to the resolved subcommand.' },
    json: { type: 'boolean', description: 'Forwarded to the resolved subcommand.', default: false },
  },
  subCommands: {
    show: termsShowCommand,
    agree: termsAgreeCommand,
  },
  default: 'show',
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
