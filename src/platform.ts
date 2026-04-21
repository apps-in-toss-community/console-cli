// Map Node's `process.platform` / `process.arch` to the binary asset names
// produced by `scripts/build-bin.ts` and attached to GitHub Releases.

export interface PlatformTarget {
  os: 'linux' | 'darwin' | 'windows';
  arch: 'x64' | 'arm64';
  assetName: string;
}

export function detectPlatform(): PlatformTarget | null {
  let os: PlatformTarget['os'];
  switch (process.platform) {
    case 'linux':
      os = 'linux';
      break;
    case 'darwin':
      os = 'darwin';
      break;
    case 'win32':
      os = 'windows';
      break;
    default:
      return null;
  }

  let arch: PlatformTarget['arch'];
  switch (process.arch) {
    case 'x64':
      arch = 'x64';
      break;
    case 'arm64':
      arch = 'arm64';
      break;
    default:
      return null;
  }

  // We don't ship windows-arm64 yet — Bun's `--compile` target support is still partial.
  if (os === 'windows' && arch === 'arm64') return null;

  const suffix = os === 'windows' ? '.exe' : '';
  return { os, arch, assetName: `aitcc-${os}-${arch}${suffix}` };
}
