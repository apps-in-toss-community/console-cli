import { existsSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { completionSuggestedPath } from './paths.js';
import { argvRequestsJson, topLevelCommand } from './update-notice-hook.js';

// One-time hint: if shell tab-completion for `aitcc` is not installed, print
// a single suggestion on the first interactive run after install. Never modifies
// rc files — hint only, user copies and pastes.
//
// Design mirrors update-notice-hook.ts:
//   * Runs from exitAfterFlush (the single universal exit chokepoint).
//   * `--json` suppressed, non-TTY suppressed, excluded commands suppressed.
//   * Completion detection: fs.stat / existsSync only — no shell spawn.
//   * One-shot marker: writes completion-suggested.json to cacheDir on first
//     suggestion (or on first detection of already-installed). Never nags again.
//   * Fully defensive — never throws, never delays exit beyond a couple of fast
//     fs ops.

// Commands whose exit must NOT carry a completion hint.
const EXCLUDED_COMMANDS = new Set(['upgrade', 'completion']);

type KnownShell = 'zsh' | 'bash' | 'fish';

/**
 * Decide whether this invocation should attempt to show the completion hint.
 * Suppressed for `--json` output, excluded subcommands, and non-TTY stderr.
 */
export function shouldRunCompletionHint(argv: readonly string[]): boolean {
  if (argvRequestsJson(argv)) return false;
  const cmd = topLevelCommand(argv);
  if (cmd !== null && EXCLUDED_COMMANDS.has(cmd)) return false;
  if (!process.stderr.isTTY) return false;
  return true;
}

/** Detect the current shell from `$SHELL`. Returns null for unknown / absent. */
export function detectShell(env: NodeJS.ProcessEnv = process.env): KnownShell | null {
  const shell = env.SHELL;
  if (!shell) return null;
  // basename: take the last path component.
  const name = shell.split('/').pop() ?? '';
  if (name === 'zsh') return 'zsh';
  if (name === 'bash') return 'bash';
  if (name === 'fish') return 'fish';
  return null;
}

/**
 * Check whether the completion script for `aitcc` is already installed for the
 * given shell. Uses existsSync / stat — no shell spawning.
 * `existsFn` is injectable for testing; production callers omit it.
 */
export function isCompletionInstalled(
  shell: KnownShell,
  env: NodeJS.ProcessEnv = process.env,
  existsFn: (p: string) => boolean = existsSync,
): boolean {
  const home = env.HOME ?? '';
  const xdgData = env.XDG_DATA_HOME ?? (home ? join(home, '.local', 'share') : '');
  const xdgConfig = env.XDG_CONFIG_HOME ?? (home ? join(home, '.config') : '');

  let candidates: string[] = [];

  if (shell === 'zsh') {
    candidates = [
      '/opt/homebrew/share/zsh/site-functions/_aitcc',
      '/usr/local/share/zsh/site-functions/_aitcc',
      home ? join(home, '.zsh', 'completions', '_aitcc') : '',
      xdgData ? join(xdgData, 'zinit', 'completions', '_aitcc') : '',
      xdgConfig ? join(xdgConfig, 'zsh', 'completions', '_aitcc') : '',
      home ? join(home, '.zfunc', '_aitcc') : '',
    ];
  } else if (shell === 'fish') {
    candidates = [xdgConfig ? join(xdgConfig, 'fish', 'completions', 'aitcc.fish') : ''];
  } else if (shell === 'bash') {
    candidates = [
      '/etc/bash_completion.d/aitcc',
      '/usr/local/etc/bash_completion.d/aitcc',
      home ? join(home, '.bash_completion.d', 'aitcc') : '',
      xdgData ? join(xdgData, 'bash-completion', 'completions', 'aitcc') : '',
    ];
  }

  for (const candidate of candidates) {
    if (candidate && existsFn(candidate)) return true;
  }
  return false;
}

/** Per-shell install one-liner (mirrors install.sh lines 241-255). */
function hintOneLiner(shell: KnownShell): string {
  if (shell === 'bash') {
    return '  source <(aitcc completion bash)';
  }
  if (shell === 'zsh') {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal zsh syntax, not a JS template placeholder
    return '  aitcc completion zsh > "${fpath[1]}/_aitcc"';
  }
  // fish
  return '  aitcc completion fish > ~/.config/fish/completions/aitcc.fish';
}

/** Per-shell add-to-rc qualifier (mirrors install.sh wording). */
function hintQualifier(shell: KnownShell): string {
  if (shell === 'bash') return '~/.bashrc에 추가:';
  if (shell === 'zsh') return '한 번 실행 후 새 셸을 열면 됩니다:';
  return '한 번 실행하면 됩니다:';
}

/** Write the one-shot marker file atomically. */
async function writeMarker(): Promise<void> {
  const path = completionSuggestedPath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  const body = JSON.stringify({ suggestedAt: new Date().toISOString() }, null, 2);
  try {
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Main hook — call from `exitAfterFlush` right before `process.exit`.
 * Never throws. Bounded by a handful of synchronous existsSync calls plus
 * one small async file write.
 */
export async function maybeSuggestCompletionOnExit(
  argv: readonly string[] = process.argv,
): Promise<void> {
  await _maybeSuggestCompletionOnExit(argv, process.env).catch(() => {
    // Fully defensive: a throw here must never mask the command's real exit.
  });
}

/** Internal implementation, separated for testability (injectable env + existsFn). */
export async function _maybeSuggestCompletionOnExit(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  existsFn: (p: string) => boolean = existsSync,
  writeMarkerFn: () => Promise<void> = writeMarker,
): Promise<void> {
  if (!shouldRunCompletionHint(argv)) return;

  // One-shot: if marker is already present (or any I/O error), stay silent.
  // existsFn returns false only when the path is clearly absent.
  if (existsFn(completionSuggestedPath())) return;

  const shell = detectShell(env);
  if (!shell) return;

  const installed = isCompletionInstalled(shell, env, existsFn);

  if (installed) {
    // Already installed — write the marker so we never scan again.
    await writeMarkerFn().catch(() => {});
    return;
  }

  // Not installed — emit the one-time hint to stderr.
  const dim = env.NO_COLOR ? '' : '\x1b[2m';
  const reset = env.NO_COLOR ? '' : '\x1b[0m';

  const qualifier = hintQualifier(shell);
  const oneLiner = hintOneLiner(shell);

  process.stderr.write(
    `\n${dim}(aitcc 자동완성이 설치되어 있지 않습니다 — 한 번 설치하면 탭 완성이 동작합니다.\n` +
      ` ${qualifier}\n` +
      `${oneLiner}\n` +
      ` 다시 표시하지 않습니다.)${reset}\n`,
  );

  await writeMarkerFn().catch(() => {});
}
