import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupStaleUpgradeArtifacts } from './upgrade.js';

describe('cleanupStaleUpgradeArtifacts', () => {
  const originalPlatform = process.platform;
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'aitcc-upgrade-cleanup-'));
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    await rm(workDir, { recursive: true, force: true });
  });

  it('is a no-op on POSIX even when an .old file exists', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const exe = join(workDir, 'aitcc');
    const old = `${exe}.old`;
    await writeFile(old, 'stale');

    await cleanupStaleUpgradeArtifacts(exe);

    // POSIX path must not touch the file — cleanup is Windows-only.
    await expect(stat(old)).resolves.toBeDefined();
  });

  it('removes <exePath>.old on win32 when present', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const exe = join(workDir, 'aitcc.exe');
    const old = `${exe}.old`;
    await writeFile(old, 'stale');

    await cleanupStaleUpgradeArtifacts(exe);

    await expect(stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not throw on win32 when <exePath>.old is absent', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const exe = join(workDir, 'aitcc.exe');

    await expect(cleanupStaleUpgradeArtifacts(exe)).resolves.toBeUndefined();
  });

  it('does not throw when exePath is empty', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await expect(cleanupStaleUpgradeArtifacts('')).resolves.toBeUndefined();
  });
});
