import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _maybeSuggestCompletionOnExit,
  detectShell,
  isCompletionInstalled,
  maybeSuggestCompletionOnExit,
  shouldRunCompletionHint,
} from './completion-hint.js';

// Helper: build a process.argv-shaped array ([execPath, scriptPath, ...rest]).
const argv = (...rest: string[]) => ['/usr/bin/node', '/path/aitcc', ...rest];

// ---------------------------------------------------------------------------
// Isolated cacheDir so tests never touch the real ~/.cache/aitcc.
// `completionSuggestedPath()` reads XDG_CACHE_HOME, so overriding it here
// ensures any accidental real-fs writes go to a harmless temp path.
// ---------------------------------------------------------------------------

let originalXdgCacheHome: string | undefined;
let testCacheDir: string;

beforeEach(() => {
  originalXdgCacheHome = process.env.XDG_CACHE_HOME;
  testCacheDir = `/tmp/aitcc-test-cache-${process.pid}-${Date.now()}`;
  process.env.XDG_CACHE_HOME = testCacheDir;
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// shouldRunCompletionHint (decision fn)
// ---------------------------------------------------------------------------

describe('shouldRunCompletionHint', () => {
  it('allows a normal interactive command', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    expect(shouldRunCompletionHint(argv('app', 'status'))).toBe(true);
    expect(shouldRunCompletionHint(argv('whoami'))).toBe(true);
  });

  it('is suppressed when --json is present', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    expect(shouldRunCompletionHint(argv('app', 'status', '--json'))).toBe(false);
    expect(shouldRunCompletionHint(argv('whoami', '--json=true'))).toBe(false);
  });

  it('is suppressed for the upgrade command', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    expect(shouldRunCompletionHint(argv('upgrade'))).toBe(false);
    expect(shouldRunCompletionHint(argv('upgrade', '--force'))).toBe(false);
  });

  it('is suppressed for the completion command', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    expect(shouldRunCompletionHint(argv('completion', 'zsh'))).toBe(false);
  });

  it('is suppressed when stderr is not a TTY (non-interactive)', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    expect(shouldRunCompletionHint(argv('app', 'status'))).toBe(false);
  });

  it('is suppressed when stderr.isTTY is undefined (piped)', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: undefined, configurable: true });
    expect(shouldRunCompletionHint(argv('app', 'status'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectShell
// ---------------------------------------------------------------------------

describe('detectShell', () => {
  it('detects zsh from a full path', () => {
    expect(detectShell({ SHELL: '/bin/zsh' })).toBe('zsh');
    expect(detectShell({ SHELL: '/usr/local/bin/zsh' })).toBe('zsh');
  });

  it('detects bash', () => {
    expect(detectShell({ SHELL: '/bin/bash' })).toBe('bash');
  });

  it('detects fish', () => {
    expect(detectShell({ SHELL: '/usr/local/bin/fish' })).toBe('fish');
  });

  it('returns null for an unknown shell', () => {
    expect(detectShell({ SHELL: '/bin/sh' })).toBe(null);
    expect(detectShell({ SHELL: '/usr/bin/tcsh' })).toBe(null);
  });

  it('returns null when SHELL is absent', () => {
    expect(detectShell({})).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// isCompletionInstalled — uses injectable existsFn to avoid ESM spy issues
// ---------------------------------------------------------------------------

describe('isCompletionInstalled', () => {
  it('returns false when none of the zsh candidate paths exist', () => {
    const existsFn = () => false;
    expect(isCompletionInstalled('zsh', { HOME: '/home/testuser' }, existsFn)).toBe(false);
  });

  it('returns false when none of the fish candidate paths exist', () => {
    const existsFn = () => false;
    expect(isCompletionInstalled('fish', { HOME: '/home/testuser' }, existsFn)).toBe(false);
  });

  it('returns false when none of the bash candidate paths exist', () => {
    const existsFn = () => false;
    expect(isCompletionInstalled('bash', { HOME: '/home/testuser' }, existsFn)).toBe(false);
  });

  it('returns true when the homebrew zsh candidate path exists', () => {
    const existsFn = (p: string) => p === '/opt/homebrew/share/zsh/site-functions/_aitcc';
    expect(isCompletionInstalled('zsh', { HOME: '/home/testuser' }, existsFn)).toBe(true);
  });

  it('returns true when the fish candidate path exists', () => {
    const home = '/home/testuser';
    const existsFn = (p: string) => p === `${home}/.config/fish/completions/aitcc.fish`;
    expect(isCompletionInstalled('fish', { HOME: home }, existsFn)).toBe(true);
  });

  it('returns true when the system bash candidate path exists', () => {
    const existsFn = (p: string) => p === '/etc/bash_completion.d/aitcc';
    expect(isCompletionInstalled('bash', { HOME: '/home/testuser' }, existsFn)).toBe(true);
  });

  it('uses XDG_DATA_HOME for the zsh zinit path when set', () => {
    const xdgData = '/custom/data';
    const existsFn = (p: string) => p === `${xdgData}/zinit/completions/_aitcc`;
    expect(
      isCompletionInstalled('zsh', { HOME: '/home/testuser', XDG_DATA_HOME: xdgData }, existsFn),
    ).toBe(true);
  });

  it('uses XDG_CONFIG_HOME for the fish path when set', () => {
    const xdgConfig = '/custom/config';
    const existsFn = (p: string) => p === `${xdgConfig}/fish/completions/aitcc.fish`;
    expect(
      isCompletionInstalled(
        'fish',
        { HOME: '/home/testuser', XDG_CONFIG_HOME: xdgConfig },
        existsFn,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _maybeSuggestCompletionOnExit — integration tests with injected helpers
// ---------------------------------------------------------------------------

describe('_maybeSuggestCompletionOnExit', () => {
  const ttyArgv = argv('app', 'status');

  // Minimal env with no real paths that would accidentally match.
  const baseEnv = (extra: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv => ({
    SHELL: '/bin/zsh',
    HOME: testCacheDir,
    XDG_CACHE_HOME: testCacheDir,
    ...extra,
  });

  // writeMarkerFn that resolves immediately without touching disk.
  const noopWrite = vi.fn(async () => {});
  // existsFn: marker absent, completion absent.
  const noneExist = () => false;

  beforeEach(() => {
    noopWrite.mockClear();
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  });

  it('writes the hint to stderr when not installed and not yet suggested', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await _maybeSuggestCompletionOnExit(ttyArgv, baseEnv(), noneExist, noopWrite);

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('자동완성이 설치되어 있지 않습니다');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal zsh syntax, not a JS template placeholder
    expect(written).toContain('${fpath[1]}/_aitcc');
    expect(noopWrite).toHaveBeenCalledTimes(1);
  });

  it('does NOT write the hint when the marker already exists', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // existsFn: marker present (any path → true).
    const allExist = () => true;

    await _maybeSuggestCompletionOnExit(ttyArgv, baseEnv(), allExist, noopWrite);

    expect(stderrSpy).not.toHaveBeenCalled();
    expect(noopWrite).not.toHaveBeenCalled();
  });

  it('writes no hint but writes marker when completion is already installed', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // marker absent (completionSuggestedPath is in testCacheDir → false),
    // completion present (the homebrew zsh path).
    const markerPath = `${testCacheDir}/aitcc/completion-suggested.json`;
    const existsFn = (p: string) => {
      if (p === markerPath) return false;
      return p === '/opt/homebrew/share/zsh/site-functions/_aitcc';
    };

    await _maybeSuggestCompletionOnExit(ttyArgv, baseEnv(), existsFn, noopWrite);

    expect(stderrSpy).not.toHaveBeenCalled();
    expect(noopWrite).toHaveBeenCalledTimes(1);
  });

  it('does nothing when SHELL is unknown', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await _maybeSuggestCompletionOnExit(
      ttyArgv,
      baseEnv({ SHELL: '/bin/sh' }),
      noneExist,
      noopWrite,
    );

    expect(stderrSpy).not.toHaveBeenCalled();
    expect(noopWrite).not.toHaveBeenCalled();
  });

  it('does nothing when stderr is not a TTY', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await _maybeSuggestCompletionOnExit(ttyArgv, baseEnv(), noneExist, noopWrite);

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('honors NO_COLOR and omits ANSI escape codes', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await _maybeSuggestCompletionOnExit(ttyArgv, baseEnv({ NO_COLOR: '1' }), noneExist, noopWrite);

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).not.toContain('\x1b[');
    expect(written).toContain('자동완성이 설치되어 있지 않습니다');
  });

  it('emits bash hint for bash shell', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await _maybeSuggestCompletionOnExit(
      ttyArgv,
      baseEnv({ SHELL: '/bin/bash', NO_COLOR: '1' }),
      noneExist,
      noopWrite,
    );

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('source <(aitcc completion bash)');
  });

  it('emits fish hint for fish shell', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await _maybeSuggestCompletionOnExit(
      ttyArgv,
      baseEnv({ SHELL: '/usr/local/bin/fish', NO_COLOR: '1' }),
      noneExist,
      noopWrite,
    );

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('aitcc completion fish > ~/.config/fish/completions/aitcc.fish');
  });

  it('never throws even when writeMarker rejects', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const failWrite = vi.fn(async () => {
      throw new Error('EACCES: permission denied');
    });

    await expect(
      _maybeSuggestCompletionOnExit(ttyArgv, baseEnv({ NO_COLOR: '1' }), noneExist, failWrite),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// maybeSuggestCompletionOnExit (public wrapper — never rejects)
// ---------------------------------------------------------------------------

describe('maybeSuggestCompletionOnExit', () => {
  it('never rejects even when internals would throw', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    // Force an argv that will reach the existsSync call.
    // The real existsSync will run but on fresh testCacheDir → no completion found.
    // Marker also absent. It will try to write the marker to testCacheDir which
    // may fail (dir not created) — the outer .catch() must swallow it.
    await expect(maybeSuggestCompletionOnExit(argv('app', 'status'))).resolves.toBeUndefined();
  });
});
