import { execFile } from 'node:child_process';
import { chmod, copyFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { promisify } from 'node:util';
import { defineCommand } from 'citty';
import { ExitCode } from '../exit.js';
import { fetchLatestRelease, findSha256SumsAsset, versionFromTag } from '../github.js';
import { detectPlatform } from '../platform.js';
import { compareSemver } from '../semver.js';
import { parseSha256Sums, sha256OfFile } from '../sha256.js';
import { VERSION } from '../version.js';

const execFileP = promisify(execFile);

// Distinguishes a Bun-compiled standalone (where `process.execPath` points at
// the binary itself) from a Node-hosted install (where it points at `node`).
// Only the former can atomically replace itself; the latter should upgrade
// via npm.
function isStandaloneBinary(): boolean {
  const exe = basename(process.execPath).toLowerCase();
  return exe.startsWith('aitcc');
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

    // Verify the downloaded binary against `SHA256SUMS` from the same release
    // before letting it replace the running executable. Mirrors the check in
    // `install.sh`. There is no opt-out; the gate exists because the binary
    // is about to be `chmod 0755` and renamed over `process.execPath`.
    const sumsAsset = findSha256SumsAsset(release);
    if (!sumsAsset) {
      await unlink(stagingPath).catch(() => {});
      emitError(
        { reason: 'sums-missing', tag: release.tag_name },
        `Release ${release.tag_name} has no SHA256SUMS asset. It may still be uploading; retry shortly.`,
      );
      process.exit(ExitCode.UpgradeChecksumFailed);
    }

    let expected: string | undefined;
    let actual: string;
    try {
      const sumsRes = await fetch(sumsAsset.browser_download_url);
      if (!sumsRes.ok) {
        throw new Error(`SHA256SUMS download failed: ${sumsRes.status} ${sumsRes.statusText}`);
      }
      const sumsText = await sumsRes.text();
      const sums = parseSha256Sums(sumsText);
      expected = sums.get(platform.assetName);
      actual = (await sha256OfFile(stagingPath)).toLowerCase();
    } catch (err) {
      await unlink(stagingPath).catch(() => {});
      emitError(
        { reason: 'sums-fetch-failed', message: (err as Error).message },
        `Failed to verify checksum: ${(err as Error).message}`,
      );
      process.exit(ExitCode.UpgradeChecksumFailed);
    }

    if (!expected) {
      await unlink(stagingPath).catch(() => {});
      emitError(
        { reason: 'sums-no-entry', assetName: platform.assetName, tag: release.tag_name },
        `SHA256SUMS for ${release.tag_name} has no entry for ${platform.assetName}.`,
      );
      process.exit(ExitCode.UpgradeChecksumFailed);
    }

    if (expected.toLowerCase() !== actual) {
      await unlink(stagingPath).catch(() => {});
      emitError(
        {
          reason: 'sha256-mismatch',
          assetName: platform.assetName,
          expected: expected.toLowerCase(),
          actual,
        },
        `Checksum mismatch for ${platform.assetName}: expected ${expected.toLowerCase()}, got ${actual}.`,
      );
      process.exit(ExitCode.UpgradeChecksumFailed);
    }

    if (!args.json) {
      process.stdout.write('Checksum OK.\n');
    }

    // POSIX backup: copy the current binary so a failed smoke test can be
    // rolled back via `rename(backup, exe)`. We can't hard-link because the
    // staging dir might be on a different fs or have stricter perms. Windows
    // gets backup-for-free via the `<exe>.old` move below.
    const backupPath = process.platform === 'win32' ? null : `${exePath}.bak.${Date.now()}`;
    if (backupPath) {
      try {
        await copyFile(exePath, backupPath);
      } catch (err) {
        await unlink(stagingPath).catch(() => {});
        emitError(
          { reason: 'backup-failed', message: (err as Error).message, exePath, backupPath },
          `Failed to create rollback backup at ${backupPath}: ${(err as Error).message}`,
        );
        process.exit(ExitCode.Generic);
      }
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
      if (backupPath) await unlink(backupPath).catch(() => {});
      emitError(
        { reason: 'replace-failed', message: (err as Error).message, exePath, stagingPath },
        `Failed to replace binary at ${exePath}: ${(err as Error).message}`,
      );
      process.exit(ExitCode.Generic);
    }

    // Smoke test: invoke the just-installed binary with `--version`. Catches
    // "valid bytes but won't run" cases (wrong platform asset, broken
    // entitlement, OS gating) that SHA-256 verification can't see. Strict
    // version-string equality is intentionally NOT checked — a release-
    // pipeline embedding mismatch shouldn't trigger an auto-rollback.
    let smokeFailure: string | null = null;
    try {
      const { stdout } = await execFileP(exePath, ['--version'], {
        timeout: 10_000,
        windowsHide: true,
      });
      if (!stdout.trim()) smokeFailure = 'empty stdout from --version';
    } catch (err) {
      smokeFailure = (err as Error).message;
    }

    if (smokeFailure) {
      let rollbackError: string | null = null;
      try {
        if (process.platform === 'win32') {
          await unlink(exePath);
          await rename(`${exePath}.old`, exePath);
        } else if (backupPath) {
          await rename(backupPath, exePath);
        }
      } catch (err) {
        rollbackError = (err as Error).message;
      }
      emitError(
        {
          reason: 'smoke-test-failed',
          message: smokeFailure,
          exePath,
          ...(rollbackError ? { rollbackError, backupPath } : { rolledBack: true }),
        },
        rollbackError
          ? `New binary failed --version smoke test: ${smokeFailure}\nRollback also failed: ${rollbackError}\nBackup left at ${backupPath ?? `${exePath}.old`}.`
          : `New binary failed --version smoke test: ${smokeFailure}\nReverted to previous binary.`,
      );
      process.exit(ExitCode.UpgradeSmokeTestFailed);
    }

    if (backupPath) await unlink(backupPath).catch(() => {});

    emit(
      {
        ok: true,
        status: 'upgraded',
        from: current,
        to: latest,
        installedAt: exePath,
        installedIn: dirname(exePath),
      },
      `Upgraded aitcc: ${current} → ${latest}`,
    );
  },
});
