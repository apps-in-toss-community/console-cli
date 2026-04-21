import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { __test, ChromeNotFoundError, chromeCandidates, findChrome } from './chrome.js';

describe('chromeCandidates', () => {
  it('honours AITCC_BROWSER first on every platform', () => {
    const { candidates } = chromeCandidates({ AITCC_BROWSER: '/tmp/my-chrome' }, 'darwin');
    expect(candidates[0]).toBe('/tmp/my-chrome');
  });

  it('uses absolute Application paths on macOS', () => {
    const { candidates } = chromeCandidates({}, 'darwin');
    expect(candidates.every((c) => c.startsWith('/'))).toBe(true);
    expect(candidates.some((c) => c.includes('Google Chrome.app'))).toBe(true);
  });

  it('uses bare command names on Linux so PATH lookup can kick in', () => {
    const { candidates } = chromeCandidates({}, 'linux');
    expect(candidates).toContain('google-chrome-stable');
    expect(candidates.every((c) => !c.startsWith('/'))).toBe(true);
  });

  it('uses PROGRAMFILES-rooted absolute paths on Windows', () => {
    const { candidates } = chromeCandidates(
      { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' },
      'win32',
    );
    expect(candidates).toContain('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(candidates).toContain(
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    );
  });
});

describe('findChrome', () => {
  it('returns an absolute candidate that exists and is executable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aitcc-chrome-abs-'));
    const fake = join(dir, 'my-chrome');
    writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    chmodSync(fake, 0o755);
    const resolved = await findChrome({ AITCC_BROWSER: fake }, 'darwin');
    expect(resolved).toBe(fake);
  });

  it('resolves a PATH-based candidate to an executable file in $PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aitcc-chrome-path-'));
    const fake = join(dir, 'google-chrome');
    writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    chmodSync(fake, 0o755);
    const resolved = await findChrome({ PATH: dir }, 'linux');
    expect(resolved).toBe(fake);
  });

  it('skips PATH entries where the candidate exists but is not executable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aitcc-chrome-noexec-'));
    const fake = join(dir, 'google-chrome');
    writeFileSync(fake, 'noop');
    chmodSync(fake, 0o644); // not executable
    await expect(findChrome({ PATH: dir }, 'linux')).rejects.toBeInstanceOf(ChromeNotFoundError);
  });

  it('throws ChromeNotFoundError when nothing matches', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'aitcc-chrome-empty-'));
    // Target Linux with an empty PATH so the only candidates are bare
    // command names that cannot be resolved. The AITCC_BROWSER override
    // points at a non-existent absolute path to exhaust that branch too.
    await expect(
      findChrome({ AITCC_BROWSER: join(emptyDir, 'nonexistent'), PATH: '' }, 'linux'),
    ).rejects.toBeInstanceOf(ChromeNotFoundError);
  });
});

describe('consumeDevtoolsEndpoint', () => {
  it('extracts the ws:// URL from the Chrome banner', () => {
    const buf = [
      'Other noise',
      'DevTools listening on ws://127.0.0.1:54321/devtools/browser/abc-def',
      '',
    ].join('\n');
    expect(__test.consumeDevtoolsEndpoint(buf)).toBe(
      'ws://127.0.0.1:54321/devtools/browser/abc-def',
    );
  });

  it('returns null before the banner appears', () => {
    expect(__test.consumeDevtoolsEndpoint('just stderr chatter\n')).toBeNull();
  });

  it('ignores non-stderr noise that merely contains "DevTools"', () => {
    expect(__test.consumeDevtoolsEndpoint('DevTools is cool\n')).toBeNull();
  });
});
