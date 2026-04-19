import { spawn } from 'node:child_process';

// Best-effort cross-platform "open this URL in the default browser". On
// failure the caller prints the URL so the user can copy it manually. We
// deliberately avoid pulling in an `open`-package dependency — the matrix we
// care about (macOS / Linux / Windows) is tiny.

export interface OpenBrowserResult {
  readonly launched: boolean;
}

export function openBrowser(url: string): Promise<OpenBrowserResult> {
  // Allow tests and headless environments to skip the spawn entirely.
  if (process.env.AIT_CONSOLE_NO_BROWSER === '1') {
    return Promise.resolve({ launched: false });
  }

  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        // `cmd /c start` needs the `""` window-title placeholder so a URL
        // containing `&` isn't reinterpreted. `windowsVerbatimArguments`
        // keeps Node from re-quoting our already-quoted arguments, which
        // would otherwise corrupt URLs with special characters. We also
        // wrap the URL in double-quotes so an intervening literal space
        // (rare but legal through redirects/proxies) is treated as part
        // of the argument.
        const quotedUrl = `"${url.replace(/"/g, '%22')}"`;
        const child = spawn('cmd', ['/c', 'start', '""', quotedUrl], {
          stdio: 'ignore',
          detached: true,
          windowsHide: true,
          windowsVerbatimArguments: true,
        });
        child.once('error', () => resolve({ launched: false }));
        child.once('spawn', () => {
          child.unref();
          resolve({ launched: true });
        });
        return;
      }
      const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(command, [url], {
        stdio: 'ignore',
        detached: true,
      });
      child.once('error', () => resolve({ launched: false }));
      child.once('spawn', () => {
        child.unref();
        resolve({ launched: true });
      });
    } catch {
      resolve({ launched: false });
    }
  });
}
