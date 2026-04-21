import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Thin cross-platform launcher for an existing Chrome/Chromium-family
// browser with the Chrome DevTools Protocol enabled. We drive the session
// over CDP rather than relying on Playwright so `bun build --compile` keeps
// producing a ~10 MB standalone binary with no bundled Chromium.
//
// We deliberately use an ephemeral `--user-data-dir` so the login session
// is isolated from the user's everyday browser profile. The caller is
// responsible for disposing the session (we expose a `dispose()` helper
// that kills the process and removes the temp dir).

export interface ChromePaths {
  readonly candidates: readonly string[];
}

export class ChromeNotFoundError extends Error {
  constructor(readonly candidates: readonly string[]) {
    super(
      `Could not find Chrome or a Chromium-family browser. Tried: ${candidates.join(', ')}.\n` +
        'Install Chrome, or set AIT_CONSOLE_BROWSER to an executable path.',
    );
    this.name = 'ChromeNotFoundError';
  }
}

export class ChromeLaunchError extends Error {
  constructor(
    readonly executable: string,
    cause: Error,
  ) {
    super(`Failed to launch ${executable}: ${cause.message}`);
    this.name = 'ChromeLaunchError';
    this.cause = cause;
  }
}

export class ChromeEndpointTimeoutError extends Error {
  constructor(readonly executable: string) {
    super(
      `${executable} did not print a DevTools endpoint within the timeout. ` +
        'It may have been blocked by the OS or launched a GUI-less variant.',
    );
    this.name = 'ChromeEndpointTimeoutError';
  }
}

// Probe order: the common install paths, favouring the vendor's own packaging
// over snap/flatpak (those sometimes restrict --remote-debugging-port writes
// due to sandboxing). Respect $AIT_CONSOLE_BROWSER as an override.
export function chromeCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ChromePaths {
  const override = env.AIT_CONSOLE_BROWSER;
  const out: string[] = [];
  if (override && override.length > 0) out.push(override);

  if (platform === 'darwin') {
    out.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Arc.app/Contents/MacOS/Arc',
    );
  } else if (platform === 'win32') {
    // Build Windows-style paths explicitly. We can't use `path.join` here
    // because Node uses the host OS's path module (so on a POSIX test
    // runner it would produce `/`-separated strings that never exist on
    // Windows).
    const pf = env.PROGRAMFILES ?? 'C:\\Program Files';
    const pf86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA ?? `${homedir() || 'C:\\'}\\AppData\\Local`;
    out.push(
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    );
  } else {
    // Linux and the rest: rely on PATH lookup via plain command names.
    out.push(
      'google-chrome-stable',
      'google-chrome',
      'chromium-browser',
      'chromium',
      'microsoft-edge-stable',
      'microsoft-edge',
    );
  }

  return { candidates: out };
}

function isAbsolutePath(p: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return /^[A-Za-z]:\\/.test(p);
  return p.startsWith('/');
}

async function resolveOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const path = env.PATH ?? env.Path ?? env.path ?? '';
  if (path.length === 0) return null;
  const sep = platform === 'win32' ? ';' : ':';
  const fs = await import('node:fs/promises');
  for (const dir of path.split(sep)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

export async function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const { candidates } = chromeCandidates(env, platform);
  const fs = await import('node:fs/promises');
  for (const candidate of candidates) {
    if (isAbsolutePath(candidate, platform)) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // try next
      }
      continue;
    }
    const resolved = await resolveOnPath(candidate, env, platform);
    if (resolved) return resolved;
  }
  throw new ChromeNotFoundError(candidates);
}

export interface LaunchedChrome {
  readonly process: ChildProcess;
  readonly webSocketDebuggerUrl: string;
  readonly userDataDir: string;
  dispose(): Promise<void>;
}

export interface LaunchChromeOptions {
  readonly initialUrl: string;
  readonly executable?: string;
  readonly endpointTimeoutMs?: number;
  // Hook for tests: if set, skip actually spawning Chrome and feed these
  // bytes to the stderr parser instead. Keeps the parser in the hot path
  // under test without requiring a real Chrome install on CI.
  readonly spawnOverride?: (args: readonly string[]) => ChildProcess;
}

const DEVTOOLS_BANNER = /^DevTools listening on (ws:\/\/[^\s]+)\s*$/m;

function consumeDevtoolsEndpoint(buffer: string): string | null {
  const match = DEVTOOLS_BANNER.exec(buffer);
  return match ? (match[1] ?? null) : null;
}

export async function launchChrome(options: LaunchChromeOptions): Promise<LaunchedChrome> {
  const executable = options.executable ?? (await findChrome());
  const endpointTimeoutMs = options.endpointTimeoutMs ?? 15_000;

  const userDataDir = await mkdtemp(join(tmpdir(), 'ait-console-chrome-'));

  // Minimum viable flags:
  //  --remote-debugging-port=0          pick an ephemeral port (printed on stderr)
  //  --user-data-dir=<tmp>               isolate from the user's real profile
  //  --no-first-run / --no-default-browser-check  skip greeter dialogs
  //  --password-store=basic              avoid prompting for keyring unlocks on Linux
  //  --use-mock-keychain                 same, but for macOS keychain
  const args: string[] = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    '--password-store=basic',
    '--use-mock-keychain',
    options.initialUrl,
  ];

  const spawnFn = options.spawnOverride ?? ((a: readonly string[]) => spawn(executable, [...a]));
  let child: ChildProcess;
  try {
    child = spawnFn(args);
  } catch (err) {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw new ChromeLaunchError(executable, err as Error);
  }

  const dispose = async (): Promise<void> => {
    try {
      if (!child.killed) child.kill('SIGTERM');
    } catch {
      // best-effort
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  };

  let stderrBuf = '';
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new ChromeEndpointTimeoutError(executable));
    }, endpointTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const onStderr = (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      const found = consumeDevtoolsEndpoint(stderrBuf);
      if (found) {
        cleanup();
        resolve(found);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new ChromeLaunchError(
          executable,
          new Error(`process exited with code ${code ?? 'null'} before printing endpoint`),
        ),
      );
    };
    const onError = (err: Error) => {
      cleanup();
      reject(new ChromeLaunchError(executable, err));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.stderr?.on('data', onStderr);
    child.on('exit', onExit);
    child.on('error', onError);
  }).catch(async (err) => {
    await dispose();
    throw err;
  });

  return {
    process: child,
    webSocketDebuggerUrl: wsUrl,
    userDataDir,
    dispose,
  };
}

// Exported for unit tests.
export const __test = { consumeDevtoolsEndpoint };
