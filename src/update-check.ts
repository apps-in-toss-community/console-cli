import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchLatestReleaseConditional, versionFromTag } from './github.js';
import { upgradeCheckPath } from './paths.js';
import { compareSemver } from './semver.js';
import { VERSION } from './version.js';

// Background "is there a newer aitcc?" probe. Rate-limit friendly by design:
//
//   * At most one network call every 24 hours, regardless of how often the
//     user runs a command that opts in.
//   * Even a failed probe updates the cache timestamp, so a broken network
//     (or a 403 from GitHub) does not loop us back within minutes.
//   * Cache write is stamped BEFORE the network call and promoted atomically
//     via tempfile+rename, so two concurrent `aitcc whoami` invocations can't
//     both escape the throttle and an `exitAfterFlush` mid-write can't leave
//     a truncated JSON file.
//   * Uses a conditional GET with the previous ETag — a 304 response does
//     not consume the anonymous 60/hr core rate-limit bucket.
//   * Fully opt-out via AITCC_NO_UPDATE_CHECK=1 (and implicitly disabled
//     when stderr is not a TTY, so agent-plugin / script consumers never
//     see a stray notice line).
//
// The `upgrade` command does NOT use this path — it's the explicit fetch,
// runs immediately on demand, and its output is the point.

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckCache {
  readonly lastCheckedAt: string; // ISO 8601
  readonly latestTag?: string;
  readonly etag?: string;
}

export async function readCache(): Promise<UpdateCheckCache | null> {
  let raw: string;
  try {
    raw = await readFile(upgradeCheckPath(), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.lastCheckedAt !== 'string') return null;
  // Reject non-string optional fields — a hand-edited or cross-version cache
  // with wrong types shouldn't corrupt later string operations.
  if (obj.latestTag !== undefined && typeof obj.latestTag !== 'string') return null;
  if (obj.etag !== undefined && typeof obj.etag !== 'string') return null;
  const result: UpdateCheckCache = {
    lastCheckedAt: obj.lastCheckedAt,
    ...(obj.latestTag !== undefined ? { latestTag: obj.latestTag as string } : {}),
    ...(obj.etag !== undefined ? { etag: obj.etag as string } : {}),
  };
  return result;
}

export async function writeCache(entry: UpdateCheckCache): Promise<void> {
  const path = upgradeCheckPath();
  await mkdir(dirname(path), { recursive: true });
  // Atomic promote: write to a unique sibling tempfile, then rename. On
  // POSIX rename(2) is atomic within the same filesystem, so a truncated
  // or crash-interrupted write never becomes the canonical cache file.
  // Windows is best-effort (ReplaceFileW is atomic for same-volume targets
  // but not guaranteed cross-process).
  // Unique-per-caller tempfile: pid + wall-clock + random suffix. Prevents
  // concurrent writers in the same process (Date.now() has ms resolution and
  // can collide) from stealing each other's tempfiles between writeFile and
  // rename.
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    // Cache body is non-secret, but mtime + the ETag are a mild leak of
    // "when this user last ran aitcc" on a multi-user box. Match session
    // storage's 0600 mode for consistency and defence in depth.
    await writeFile(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    // If rename failed we may have left the tempfile behind; clean up.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Has the throttle window elapsed since the last recorded check? */
export function isDueForCheck(
  cache: UpdateCheckCache | null,
  now: number = Date.now(),
  intervalMs: number = UPDATE_CHECK_INTERVAL_MS,
): boolean {
  if (!cache) return true;
  const last = Date.parse(cache.lastCheckedAt);
  if (!Number.isFinite(last)) return true;
  // If the system clock jumps backwards (NTP resync, VM resume), treat the
  // cache as stale and re-check. Better to probe once than to be silently
  // stuck until wall-time catches up to `last + interval`.
  if (now < last) return true;
  return now - last >= intervalMs;
}

export interface UpdateCheckOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly now?: number;
  readonly intervalMs?: number;
}

/**
 * Perform the throttled update check. Returns the final cache entry (for
 * testing) or null when skipped. Never throws — network errors are
 * intentionally swallowed so they never interrupt the foreground command.
 */
export async function maybeCheckForUpdate(
  opts: UpdateCheckOptions = {},
): Promise<UpdateCheckCache | null> {
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? Boolean(process.stderr.isTTY);
  const now = opts.now ?? Date.now();
  const intervalMs = opts.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;

  // Opt-out: any non-empty value that isn't explicitly falsey counts. Matches
  // the loose convention used by CI / DEBUG env vars — "AITCC_NO_UPDATE_CHECK=true"
  // works alongside "=1".
  const optOut = env.AITCC_NO_UPDATE_CHECK;
  if (optOut && optOut !== '0' && optOut.toLowerCase() !== 'false') return null;
  // Notice lines are targeted at interactive users. Checking stderr (where
  // the notice is written) rather than stdout means `aitcc whoami > out.log`
  // still shows the notice on the terminal, while a fully piped invocation
  // (stderr redirected or captured) is silent.
  if (!isTTY) return null;

  const cache = await readCache();
  if (!isDueForCheck(cache, now, intervalMs)) return null;

  // Stamp the cache BEFORE the network call so a concurrent `aitcc whoami`
  // reading this file mid-probe sees "not due" and doesn't issue a second
  // request. If the probe crashes the process, this placeholder also
  // naturally satisfies the "failed probes still update the window"
  // invariant — the next run is bounded by the interval.
  const nowIso = new Date(now).toISOString();
  const placeholder: UpdateCheckCache = {
    lastCheckedAt: nowIso,
    ...(cache?.latestTag !== undefined ? { latestTag: cache.latestTag } : {}),
    ...(cache?.etag !== undefined ? { etag: cache.etag } : {}),
  };
  await writeCache(placeholder).catch(() => {
    // Non-fatal: proceed with the probe, we'll try to write again on
    // completion. The throttle guarantee weakens here but bounded by
    // whatever caused the write to fail in the first place.
  });

  const previousEtag = cache?.etag;
  let entry: UpdateCheckCache = placeholder;
  try {
    const result = await fetchLatestReleaseConditional(previousEtag);
    if (result.status === 'not-modified') {
      // 304: server had no new body. Keep the latestTag we already know
      // about, and refresh the ETag only if the server happened to include
      // one on the 304.
      entry = {
        lastCheckedAt: nowIso,
        ...(cache?.latestTag !== undefined ? { latestTag: cache.latestTag } : {}),
        ...(result.etag !== undefined
          ? { etag: result.etag }
          : cache?.etag !== undefined
            ? { etag: cache.etag }
            : {}),
      };
    } else {
      entry = {
        lastCheckedAt: nowIso,
        latestTag: result.release.tag_name,
        ...(result.etag !== undefined ? { etag: result.etag } : {}),
      };
    }
    await writeCache(entry).catch(() => {
      // Placeholder already wrote above; ignore secondary write failure.
    });
  } catch {
    // Network / parse failure. Placeholder is already on disk, so the
    // throttle invariant holds — just skip the second write.
  }

  maybeEmitNotice(entry, env);
  return entry;
}

function maybeEmitNotice(entry: UpdateCheckCache, env: NodeJS.ProcessEnv): void {
  if (!entry.latestTag) return;
  // In the dev fallback VERSION (`0.0.0-dev`, from `src/version.ts` when no
  // build-time define is injected) every released tag looks "newer" and the
  // notice would fire on every `pnpm dev` run. Skip it instead — developers
  // running from source don't need an upgrade nag.
  if (VERSION.startsWith('0.0.0-dev')) return;
  const latest = versionFromTag(entry.latestTag);
  if (!latest) return;
  if (compareSemver(latest, VERSION) <= 0) return;
  // Respect NO_COLOR — CLAUDE.md documents it as honored across the CLI.
  const dim = env.NO_COLOR ? '' : '\x1b[2m';
  const reset = env.NO_COLOR ? '' : '\x1b[0m';
  // Notice goes to stderr so it never pollutes `--json` stdout.
  process.stderr.write(
    `\n${dim}(aitcc ${latest} is available — run \`aitcc upgrade\` to install)${reset}\n`,
  );
}
