import { defineCommand } from 'citty';
import { fetchApiKeys } from '../api/api-keys.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { emitFailureFromError, emitJson, resolveWorkspaceContext } from './_shared.js';

// --json contract (consumed by agent-plugin):
//
//   keys ls [--workspace <id>]:
//     { ok: true, workspaceId, keys: [{id, name, extra}], needsKey? } exit 0
//     { ok: false, reason: 'no-workspace-selected' }                  exit 2
//     { ok: false, reason: 'invalid-id', message }                    exit 2
//
//   `needsKey: true` is emitted when the key list is empty. The flag is
//   there so `/ait deploy` (and similar agent-plugin skills) can bail
//   with a friendly "issue a key first" message instead of attempting a
//   deploy that will 401 server-side. We keep the UI-specific Korean
//   wording out of JSON (it lives on stderr plain output only).
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
          ...(keys.length === 0 ? { needsKey: true } : {}),
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
      process.stdout.write(`${keys.length} API key(s) in workspace ${workspaceId}:\n`);
      for (const k of keys) {
        const name = k.name ?? '(unnamed)';
        process.stdout.write(`${k.id}\t${name}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
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
