import { describe, expect, it, vi } from 'vitest';
import { completionCommand } from './completion.js';

type Exited = { code: number };

async function captureExit(
  fn: () => Promise<unknown> | unknown,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const original = process.exit;
  let exited: Exited | null = null;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      stdout.push(String(chunk));
      const cb = rest.find((a): a is () => void => typeof a === 'function');
      cb?.();
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      stderr.push(String(chunk));
      const cb = rest.find((a): a is () => void => typeof a === 'function');
      cb?.();
      return true;
    });
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patch for tests
  (process as any).exit = ((code?: number) => {
    exited = { code: code ?? 0 };
    throw new Error(`__test_exit_${code ?? 0}__`);
  }) as never;
  try {
    await Promise.resolve(fn()).catch((err) => {
      if (!(err instanceof Error) || !err.message.startsWith('__test_exit_')) throw err;
    });
  } finally {
    process.exit = original;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  // Keep TypeScript's narrowing happy: `exited` is assigned inside a
  // monkey-patched `process.exit` (not visible to control-flow analysis)
  // and remains `Exited | null` to the checker. Cast before accessing.
  const finalCode = (exited as Exited | null)?.code ?? -1;
  return { code: finalCode, stdout: stdout.join(''), stderr: stderr.join('') };
}

// citty's defineCommand returns a value whose `.run` is the handler.
// biome-ignore lint/suspicious/noExplicitAny: shape not exported by citty
const run = (completionCommand as any).run as (ctx: {
  args: Record<string, unknown>;
}) => Promise<void>;

describe('completion command', () => {
  it('emits bash completion with all top-level commands', async () => {
    const { code, stdout } = await captureExit(() => run({ args: { shell: 'bash', json: false } }));
    expect(code).toBe(0);
    // Bash script sanity: must be bash (no zsh/fish-specific directives).
    expect(stdout).toContain('_aitcc_completion');
    expect(stdout).toContain('complete -F _aitcc_completion aitcc');
    // Every top-level command should be in the compgen list.
    expect(stdout).toMatch(/compgen -W ".*whoami.*app.*" -- "\$cur"/);
  });

  it('emits zsh completion with #compdef directive', async () => {
    const { code, stdout } = await captureExit(() => run({ args: { shell: 'zsh', json: false } }));
    expect(code).toBe(0);
    expect(stdout).toMatch(/^#compdef aitcc/);
    // Zsh script references a per-namespace subcommand list.
    expect(stdout).toContain('_values');
  });

  it('emits fish completion with __fish_use_subcommand gating', async () => {
    const { code, stdout } = await captureExit(() => run({ args: { shell: 'fish', json: false } }));
    expect(code).toBe(0);
    expect(stdout).toContain('__fish_use_subcommand');
    expect(stdout).toContain('__fish_seen_subcommand_from app');
  });

  it('exits with Usage on an unknown shell (plain mode)', async () => {
    const { code, stderr } = await captureExit(() => run({ args: { shell: 'pwsh', json: false } }));
    expect(code).toBe(2);
    expect(stderr).toContain('bash|zsh|fish');
  });

  it('exits with Usage on an unknown shell (--json)', async () => {
    const { code, stdout } = await captureExit(() => run({ args: { shell: 'pwsh', json: true } }));
    expect(code).toBe(2);
    expect(stdout).toContain('"reason":"invalid-shell"');
    expect(stdout).toContain('"allowed":["bash","zsh","fish"]');
  });

  it('exits with Usage when no shell is provided', async () => {
    const { code, stderr } = await captureExit(() =>
      run({ args: { shell: undefined, json: false } }),
    );
    expect(code).toBe(2);
    expect(stderr).toContain('Usage: aitcc completion');
  });
});
