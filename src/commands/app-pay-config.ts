import { defineCommand } from 'citty';
import { fetchPayConfigStatus } from '../api/pay-config.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import {
  emitFailureFromError,
  emitJson,
  printContextHeader,
  resolveWorkspaceContext,
  withReauthRetry,
} from './_shared.js';

// --json contract (consumed by agent-plugin):
//
//   app pay-config show [--workspace <id>]:
//     { ok: true, workspaceId, payApiKey: 'SET'|'UNSET',
//       testPayApiKey: 'SET'|'UNSET', billingPayApiKey: 'SET'|'UNSET',
//       testBillingPayApiKey: 'SET'|'UNSET',
//       tossCertClientId: 'SET'|'UNSET' }                                 exit 0
//     { ok: false, reason: 'no-workspace-selected' | 'invalid-id' }       exit 2
//
// Every subcommand inherits the standard auth/network/api failure modes
// (see `emitFailureFromError` in _shared.ts): session-expired exit 10,
// network-error exit 11, api-error exit 17.
//
// ★ SECRET-HANDLING ★ — the five Toss Pay credential fields NEVER carry
// their plaintext value here, in --json output, or anywhere else. Only a
// SET/UNSET presence flag is surfaced (same treatment as Deploy Key,
// CLAUDE.md §3.1). This is enforced at the API layer
// (`src/api/pay-config.ts#fetchPayConfigStatus`) — the raw value never even
// reaches this command module. This is workspace-scoped configuration
// (Pay is configured once per workspace, not per mini-app), so — unlike
// `app iap`/`app ads` — there is no `--app` flag.

const showCommand = defineCommand({
  meta: {
    name: 'show',
    description:
      'Show which Toss Pay credentials are configured for a workspace. Values are always masked to SET/UNSET — never printed.',
  },
  args: {
    workspace: {
      type: 'string',
      description: 'Workspace ID to inspect. Defaults to the selected workspace.',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;
    printContextHeader(ctx, { json: args.json });

    try {
      const status = await withReauthRetry(args.json, session, (s) =>
        fetchPayConfigStatus(workspaceId, s.cookies),
      );

      if (args.json) {
        emitJson({
          ok: true,
          workspaceId: status.workspaceId,
          payApiKey: status.payApiKey,
          testPayApiKey: status.testPayApiKey,
          billingPayApiKey: status.billingPayApiKey,
          testBillingPayApiKey: status.testBillingPayApiKey,
          tossCertClientId: status.tossCertClientId,
        });
        return exitAfterFlush(ExitCode.Ok);
      }

      const fields: readonly [string, string][] = [
        ['payApiKey', status.payApiKey],
        ['testPayApiKey', status.testPayApiKey],
        ['billingPayApiKey', status.billingPayApiKey],
        ['testBillingPayApiKey', status.testBillingPayApiKey],
        ['tossCertClientId', status.tossCertClientId],
      ];
      process.stdout.write(`Workspace ${workspaceId} pay config (masked — SET/UNSET only):\n`);
      for (const [name, state] of fields) {
        process.stdout.write(`  ${name}: ${state}\n`);
      }
      if (fields.every(([, state]) => state === 'UNSET')) {
        process.stdout.write(
          '토스페이 키가 아직 발급/등록되지 않았어요 — 인앱결제를 쓰려면 콘솔에서 토스페이 키를 먼저 발급받으세요.\n',
        );
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

export const payConfigCommand = defineCommand({
  meta: {
    name: 'pay-config',
    description: 'Inspect Toss Pay credential configuration state for a workspace (masked).',
  },
  subCommands: {
    show: showCommand,
  },
});
