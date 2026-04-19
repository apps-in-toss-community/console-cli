import { spawn } from 'node:child_process';

// Best-effort cross-platform "open this URL in the default browser". On
// failure the caller prints the URL so the user can copy it manually. We
// deliberately avoid pulling in an `open`-package dependency — the matrix we
// care about (macOS / Linux / Windows) is tiny.

export interface OpenBrowserResult {
  readonly launched: boolean;
}

export async function openBrowser(url: string): Promise<OpenBrowserResult> {
  // Allow tests and headless environments to skip the spawn entirely.
  if (process.env.AIT_CONSOLE_NO_BROWSER === '1') {
    return { launched: false };
  }

  const { command, args } = browserCommand(url);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
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

function browserCommand(url: string): { command: string; args: string[] } {
  if (process.platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  if (process.platform === 'win32') {
    // `start` is a cmd.exe builtin; the empty "" is the window title
    // placeholder so a URL containing `&` isn't interpreted as a title.
    return { command: 'cmd', args: ['/c', 'start', '""', url] };
  }
  return { command: 'xdg-open', args: [url] };
}
