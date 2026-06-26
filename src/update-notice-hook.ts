import { maybeCheckForUpdate } from './update-check.js';

// The throttled "is there a newer aitcc?" probe + notice, run from the single
// universal exit chokepoint (`exitAfterFlush` in flush.ts) so EVERY command
// surfaces the notice — not just `whoami`, which is the only place it used to
// fire.
//
// Why not a citty `cleanup` hook on the root command? Because every command
// exits via `exitAfterFlush` → `process.exit(code)`, which terminates the
// process BEFORE citty's recursive cleanup phase runs. A cleanup hook would
// silently never fire. `exitAfterFlush` is the real "after any command" seam
// here, so the probe lives there.
//
// Safety properties (all preserved from the old whoami-only call):
//
//   * Bounded wall-clock — 500 ms race so a slow network never delays exit. A
//     cold probe that goes long is cancelled; the next run within 24h won't
//     retry anyway (the cache is stamped when the probe starts), so cancelling
//     loses nothing.
//   * `--json` suppression — machine consumers (agent-plugin) must never see a
//     "new version available" line interleaved with parsed output. The notice
//     in update-check.ts already targets stderr and gates on `isTTY` (a piped
//     agent invocation is non-TTY and stays silent), but we ALSO scan argv for
//     `--json` so even an interactive `--json` run (TTY + structured output)
//     stays clean.
//   * Subcommand exclusions — `upgrade` is the explicit-fetch path (a "newer
//     available" line mid-upgrade is noise) and `completion` emits
//     shell-sourced output, so both opt out.
//   * Fully defensive — `maybeCheckForUpdate` swallows all network/parse errors
//     and returns null; we additionally `.catch` so nothing here can turn a
//     successful command into a failure on its way out the door.

const UPDATE_CHECK_TIMEOUT_MS = 500;

// Commands whose exit must NOT carry an update notice. Matched against the first
// non-flag argv token (the subcommand name).
const EXCLUDED_COMMANDS = new Set(['upgrade', 'completion']);

/** True if `--json` (or `--json=true`) appears anywhere in argv. */
export function argvRequestsJson(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === '--json' || arg === '--json=true') return true;
  }
  return false;
}

/**
 * The first non-flag token after `node script` — i.e. the top-level subcommand
 * name (`app`, `whoami`, `upgrade`, …), or null when none is present.
 */
export function topLevelCommand(argv: readonly string[]): string | null {
  // argv is the full process.argv: [execPath, scriptPath, ...rest].
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith('-')) return arg;
  }
  return null;
}

/**
 * Decide whether this invocation should run the update notice, from argv alone.
 * Suppressed for `--json` output and for the excluded subcommands.
 */
export function shouldRunUpdateNotice(argv: readonly string[]): boolean {
  if (argvRequestsJson(argv)) return false;
  const cmd = topLevelCommand(argv);
  if (cmd !== null && EXCLUDED_COMMANDS.has(cmd)) return false;
  return true;
}

/**
 * Run the throttled update check, bounded by a short timeout and suppressed for
 * JSON output / excluded commands. Never throws. Called from `exitAfterFlush`
 * right before `process.exit`.
 */
export async function runUpdateNoticeOnExit(argv: readonly string[] = process.argv): Promise<void> {
  if (!shouldRunUpdateNotice(argv)) return;
  await Promise.race([
    maybeCheckForUpdate().catch(() => null),
    new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), UPDATE_CHECK_TIMEOUT_MS);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]).catch(() => {
    // Defensive: both race arms are catch-guarded, but a throw on the way out
    // must never mask the command's real exit code. Swallow unconditionally.
  });
}
