import { describe, expect, it } from 'vitest';
import {
  argvRequestsJson,
  runUpdateNoticeOnExit,
  shouldRunUpdateNotice,
  topLevelCommand,
} from './update-notice-hook.js';

// Helper: build a process.argv-shaped array ([execPath, scriptPath, ...rest]).
const argv = (...rest: string[]) => ['/usr/bin/node', '/path/aitcc', ...rest];

describe('argvRequestsJson', () => {
  it('detects a bare --json flag', () => {
    expect(argvRequestsJson(argv('app', 'status', '--json'))).toBe(true);
  });

  it('detects --json=true', () => {
    expect(argvRequestsJson(argv('whoami', '--json=true'))).toBe(true);
  });

  it('is false when no json flag is present', () => {
    expect(argvRequestsJson(argv('app', 'status'))).toBe(false);
  });

  it('does not treat --no-json as json', () => {
    expect(argvRequestsJson(argv('whoami', '--no-json'))).toBe(false);
  });

  it('does not match a substring like --json-pretty', () => {
    expect(argvRequestsJson(argv('app', 'status', '--json-pretty'))).toBe(false);
  });
});

describe('topLevelCommand', () => {
  it('returns the first non-flag token after the script path', () => {
    expect(topLevelCommand(argv('app', 'ls', '--json'))).toBe('app');
    expect(topLevelCommand(argv('whoami'))).toBe('whoami');
  });

  it('skips leading flags', () => {
    expect(topLevelCommand(argv('--help'))).toBe(null);
    expect(topLevelCommand(argv('upgrade', '--force'))).toBe('upgrade');
  });

  it('returns null when there is no subcommand', () => {
    expect(topLevelCommand(argv())).toBe(null);
  });
});

describe('shouldRunUpdateNotice', () => {
  it('runs for a normal non-json command', () => {
    expect(shouldRunUpdateNotice(argv('app', 'status'))).toBe(true);
    expect(shouldRunUpdateNotice(argv('whoami'))).toBe(true);
  });

  it('is suppressed for --json output', () => {
    expect(shouldRunUpdateNotice(argv('app', 'status', '--json'))).toBe(false);
  });

  it('is suppressed for the upgrade command (explicit-fetch path)', () => {
    expect(shouldRunUpdateNotice(argv('upgrade'))).toBe(false);
    expect(shouldRunUpdateNotice(argv('upgrade', '--force'))).toBe(false);
  });

  it('is suppressed for the completion command (shell-sourced output)', () => {
    expect(shouldRunUpdateNotice(argv('completion', 'bash'))).toBe(false);
  });
});

describe('runUpdateNoticeOnExit', () => {
  it('short-circuits (no probe, no throw) when --json is requested', async () => {
    await expect(runUpdateNoticeOnExit(argv('app', 'status', '--json'))).resolves.toBeUndefined();
  });

  it('short-circuits for excluded commands', async () => {
    await expect(runUpdateNoticeOnExit(argv('upgrade'))).resolves.toBeUndefined();
  });

  it('never rejects even when the probe path runs', async () => {
    // Without --json the throttled probe path is taken. AITCC_NO_UPDATE_CHECK
    // keeps CI hermetic — maybeCheckForUpdate returns null immediately — while
    // still exercising the race + catch wrapper.
    const prev = process.env.AITCC_NO_UPDATE_CHECK;
    process.env.AITCC_NO_UPDATE_CHECK = '1';
    try {
      await expect(runUpdateNoticeOnExit(argv('app', 'status'))).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.AITCC_NO_UPDATE_CHECK;
      else process.env.AITCC_NO_UPDATE_CHECK = prev;
    }
  });
});
