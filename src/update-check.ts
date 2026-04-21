import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchLatestReleaseConditional } from './github.js';
import { upgradeCheckPath } from './paths.js';
import { compareSemver } from './semver.js';
import { VERSION } from './version.js';

// Background "is there a newer aitcc?" probe. Rate-limit friendly by design:
//
//   * At most one network call every 24 hours, regardless of how often the
//     user runs a command that opts in.
//   * Even a failed probe updates the cache timestamp, so a broken network
//     (or a 403 from GitHub) does not loop us back within minutes.
//   * Uses a conditional GET with the previous ETag — a 304 response does
//     not consume the anonymous 60/hr core rate-limit bucket.
//   * Fully opt-out via AITCC_NO_UPDATE_CHECK=1 (and implicitly disabled
//     when stdout is not a TTY, so agent-plugin / script consumers never
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
  try {
    const raw = await readFile(upgradeCheckPath(), 'utf8');
    const parsed = JSON.parse(raw) as UpdateCheckCache;
    if (typeof parsed.lastCheckedAt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCache(entry: UpdateCheckCache): Promise<void> {
  const path = upgradeCheckPath();
  await mkdir(dirname(path), { recursive: true });
  // Cache is non-secret — keep default permissions.
  await writeFile(path, JSON.stringify(entry, null, 2));
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
  return now - last >= intervalMs;
}

export interface UpdateCheckOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly now?: number;
  readonly intervalMs?: number;
}

/**
 * Perform the throttled update check. Returns the new cache entry (for
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

  if (env.AITCC_NO_UPDATE_CHECK === '1') return null;
  // Don't emit notice lines when the caller is a script or an agent — the
  // cache still updates so the interval is preserved across runs.
  if (!isTTY) return null;

  const cache = await readCache();
  if (!isDueForCheck(cache, now, intervalMs)) return null;

  const previousEtag = cache?.etag;
  const nowIso = new Date(now).toISOString();
  let entry: UpdateCheckCache;
  try {
    const result = await fetchLatestReleaseConditional(previousEtag);
    if (result.status === 'not-modified') {
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
  } catch {
    // Keep the window intact on failure so a broken network or an exhausted
    // rate-limit doesn't turn into an aggressive retry loop.
    entry = {
      lastCheckedAt: nowIso,
      ...(cache?.latestTag !== undefined ? { latestTag: cache.latestTag } : {}),
      ...(cache?.etag !== undefined ? { etag: cache.etag } : {}),
    };
  }

  await writeCache(entry).catch(() => {
    // Non-fatal: if we can't write the cache, the next command will just
    // retry — still bounded by the interval the next time it manages to
    // write successfully.
  });

  maybeEmitNotice(entry);
  return entry;
}

function maybeEmitNotice(entry: UpdateCheckCache): void {
  if (!entry.latestTag) return;
  const latest = stripTagPrefix(entry.latestTag);
  if (!latest) return;
  if (compareSemver(latest, VERSION) <= 0) return;
  // Notice goes to stderr so it never pollutes `--json` stdout.
  process.stderr.write(
    `\n\x1b[2m(aitcc ${latest} is available — run \`aitcc upgrade\` to install)\x1b[0m\n`,
  );
}

function stripTagPrefix(tag: string): string {
  const at = tag.lastIndexOf('@');
  const candidate = at >= 0 ? tag.slice(at + 1) : tag;
  return candidate.startsWith('v') ? candidate.slice(1) : candidate;
}
