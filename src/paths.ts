import { homedir } from 'node:os';
import { join } from 'node:path';

// Resolve the config directory following the XDG Base Directory spec on
// POSIX systems and using %APPDATA% on Windows. Falls back gracefully if
// environment variables are missing (e.g. minimal containers without HOME).

const APP_NAME = 'aitcc';

export function configDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData && appData.length > 0) return join(appData, APP_NAME);
    return join(homedir() || '.', 'AppData', 'Roaming', APP_NAME);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, APP_NAME);
  return join(homedir() || '.', '.config', APP_NAME);
}

export function sessionFilePath(): string {
  return join(configDir(), 'session.json');
}

// Cache directory — for non-secret, regenerable state. Distinct from
// `configDir()` so a `rm -rf ~/.cache/aitcc` cannot take the session with
// it, and so packagers can mount the two on different volumes.
export function cacheDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData && localAppData.length > 0) return join(localAppData, APP_NAME, 'Cache');
    return join(homedir() || '.', 'AppData', 'Local', APP_NAME, 'Cache');
  }
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && xdg.length > 0) return join(xdg, APP_NAME);
  return join(homedir() || '.', '.cache', APP_NAME);
}

export function upgradeCheckPath(): string {
  return join(cacheDir(), 'upgrade-check.json');
}
