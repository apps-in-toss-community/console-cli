import { defineCommand } from 'citty';
import { fetchApiKeys } from '../api/api-keys.js';
import { NetworkError, TossApiError } from '../api/http.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import {
  emitApiError,
  emitJson,
  emitNetworkError,
  emitNotAuthenticated,
  resolveWorkspaceContext,
} from './_shared.js';

// --json contract (consumed by agent-plugin):
//
//   keys ls [--workspace <id>]:
//     { ok: true, workspaceId, keys: [{id, name, extra}] } exit 0
//     { ok: false, reason: 'no-workspace-selected' }       exit 2
//     { ok: false, reason: 'invalid-id', message }         exit 2
//
//   Auth/network/api failures follow the shared contract (exit 10/11/17).
//
// "Console API key" in upstream terminology — used to authenticate
// automated deploys. We only list here; `keys create` is a follow-up
// (the management UI 404s until an initial key is issued, so we don't
// know the creation/rotation endpoint yet).

const lsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List console API keys in the selected workspace.',
  },
  args: {
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace (`aitcc workspace use`).',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const keys = await fetchApiKeys(workspaceId, session.cookies);
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          keys: keys.map((k) => ({ id: k.id, name: k.name ?? null, extra: k.extra })),
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      if (keys.length === 0) {
        process.stdout.write(`No API keys in workspace ${workspaceId}.\n`);
        process.stderr.write(
          'Hint: issue a key from the console UI (API 키 → 발급받기) to enable deploy automation.\n',
        );
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const k of keys) {
        const name = k.name ?? '(unnamed)';
        process.stdout.write(`${k.id}\t${name}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      if (err instanceof TossApiError && err.isAuthError) {
        emitNotAuthenticated(args.json, 'session-expired');
        return exitAfterFlush(ExitCode.NotAuthenticated);
      }
      if (err instanceof NetworkError) {
        emitNetworkError(args.json, err.message);
        return exitAfterFlush(ExitCode.NetworkError);
      }
      emitApiError(args.json, (err as Error).message);
      return exitAfterFlush(ExitCode.ApiError);
    }
  },
});

export const keysCommand = defineCommand({
  meta: {
    name: 'keys',
    description: 'Inspect console API keys used for deploy automation.',
  },
  subCommands: {
    ls: lsCommand,
  },
});
