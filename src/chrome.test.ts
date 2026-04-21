import { describe, expect, it } from 'vitest';
import { __test, chromeCandidates } from './chrome.js';

describe('chromeCandidates', () => {
  it('honours AIT_CONSOLE_BROWSER first on every platform', () => {
    const { candidates } = chromeCandidates({ AIT_CONSOLE_BROWSER: '/tmp/my-chrome' }, 'darwin');
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
