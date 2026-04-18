import { chmod, rename, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { defineCommand } from 'citty';
import { ExitCode } from '../exit.js';
import { fetchLatestRelease, versionFromTag } from '../github.js';
import { detectPlatform } from '../platform.js';
import { compareSemver } from '../semver.js';
import { VERSION } from '../version.js';

// Distinguishes a Bun-compiled standalone (where `process.execPath` points at
// the binary itself) from a Node-hosted install (where it points at `node`).
// Only the former can atomically replace itself; the latter should upgrade
// via npm.
function isStandaloneBinary(): boolean {
  const exe = basename(process.execPath).toLowerCase();
  return exe.startsWith('ait-console');
}

export const upgradeCommand = defineCommand({
  meta: {
    name: 'upgrade',
    description: 'Download the latest release binary from GitHub and replace the current one.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON to stdout.',
      default: false,
    },
    force: {
      type: 'boolean',
      description: 'Re-install even if already on the latest version.',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Check for updates without downloading or replacing.',
      default: false,
    },
  },
  async run({ args }) {
    const emit = (payload: Record<string, unknown>, human: string) => {
      if (args.json) {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
      } else {
        process.stdout.write(`${human}\n`);
      }
    };
    const emitError = (payload: Record<string, unknown>, human: string) => {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, ...payload })}\n`);
      } else {
        process.stderr.write(`${human}\n`);
      }
    };

    let release: Awaited<ReturnType<typeof fetchLatestRelease>>;
    try {
      release = await fetchLatestRelease();
    } catch (err) {
      emitError(
        { reason: 'network-error', message: (err as Error).message },
        `Failed to query GitHub releases: ${(err as Error).message}`,
      );
      process.exit(ExitCode.NetworkError);
    }

    const latest = versionFromTag(release.tag_name);
    const current = VERSION;
    const cmp = compareSemver(latest, current);
    const needsUpdate = cmp > 0 || args.force;

    if (!needsUpdate) {
      emit(
        { ok: true, status: 'already-latest', current, latest },
        `Already on the latest version (${current}).`,
      );
      process.exit(ExitCode.UpgradeAlreadyLatest);
    }

    if (args['dry-run']) {
      emit(
        { ok: true, status: 'update-available', current, latest, url: release.html_url },
        `Update available: ${current} → ${latest}\n${release.html_url}`,
      );
      return;
    }

    if (!isStandaloneBinary()) {
      emitError(
        {
          reason: 'not-standalone',
          current,
          latest,
          hint: 'npm i -g @ait-co/console-cli@latest',
        },
        [
          'This install was launched via Node, not the standalone binary.',
          'Self-upgrade is only supported for the compiled binary.',
          `Run: npm i -g @ait-co/console-cli@latest  (currently ${current}, latest ${latest})`,
        ].join('\n'),
      );
      process.exit(ExitCode.UpgradeUnavailable);
    }

    const platform = detectPlatform();
    if (!platform) {
      emitError(
        {
          reason: 'unsupported-platform',
          platform: process.platform,
          arch: process.arch,
        },
        `No prebuilt binary for ${process.platform}/${process.arch}.`,
      );
      process.exit(ExitCode.UpgradeUnavailable);
    }

    const asset = release.assets.find((a) => a.name === platform.assetName);
    if (!asset) {
      emitError(
        { reason: 'asset-missing', assetName: platform.assetName, tag: release.tag_name },
        `Release ${release.tag_name} has no asset named ${platform.assetName}. It may still be uploading.`,
      );
      process.exit(ExitCode.UpgradeUnavailable);
    }

    const exePath = process.execPath;
    const stagingPath = `${exePath}.new.${Date.now()}`;

    if (!args.json) {
      process.stdout.write(`Downloading ${asset.name} (${latest})...\n`);
    }

    try {
      const res = await fetch(asset.browser_download_url);
      if (!res.ok || !res.body) {
        throw new Error(`Download failed: ${res.status} ${res.statusText}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      await writeFile(stagingPath, buf, { mode: 0o755 });
      await chmod(stagingPath, 0o755);
    } catch (err) {
      emitError(
        { reason: 'download-failed', message: (err as Error).message },
        `Failed to download new binary: ${(err as Error).message}`,
      );
      process.exit(ExitCode.NetworkError);
    }

    // Atomic replace. POSIX `rename(2)` on the same filesystem is atomic.
    // On Windows a running exe can't be overwritten directly; the staging
    // path is in the same dir, so rename-over works on most shells, and we
    // leave `<exe>.old` handling to a future refinement.
    try {
      if (process.platform === 'win32') {
        await rename(exePath, `${exePath}.old`);
        await rename(stagingPath, exePath);
      } else {
        await rename(stagingPath, exePath);
      }
    } catch (err) {
      emitError(
        { reason: 'replace-failed', message: (err as Error).message, exePath, stagingPath },
        `Failed to replace binary at ${exePath}: ${(err as Error).message}`,
      );
      process.exit(ExitCode.Generic);
    }

    emit(
      {
        ok: true,
        status: 'upgraded',
        from: current,
        to: latest,
        installedAt: exePath,
        installedIn: dirname(exePath),
      },
      `Upgraded ait-console: ${current} → ${latest}`,
    );
  },
});
