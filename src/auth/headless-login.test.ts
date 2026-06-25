// Minimal unit tests for `headlessLoginFromCredentials`.
// All Chrome/CDP seams are mocked at the module level so no real browser is
// launched. The tests verify outcome routing (ok, step-up, various failures)
// and that no secret material surfaces in the returned reason strings.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock heavy modules before importing the module under test ---

vi.mock('../chrome.js', () => ({
  ChromeNotFoundError: class ChromeNotFoundError extends Error {
    candidates: string[] = [];
  },
  ChromeLaunchError: class ChromeLaunchError extends Error {},
  ChromeEndpointTimeoutError: class ChromeEndpointTimeoutError extends Error {},
  launchChrome: vi.fn(),
}));

vi.mock('../cdp.js', () => ({
  CdpClient: {
    connect: vi.fn(),
  },
  attachToFirstPage: vi.fn(),
  getAllCookies: vi.fn(),
}));

vi.mock('../login-headless.js', () => ({
  runHeadlessLogin: vi.fn(),
}));

vi.mock('../commands/login.js', () => ({
  resolveUserWithRetry: vi.fn(),
  isLoginLanding: vi.fn(() => false),
}));

vi.mock('../session.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../session.js')>();
  return {
    ...real,
    writeSession: vi.fn(),
    readSession: vi.fn(),
  };
});

import * as cdpMod from '../cdp.js';
// Import mocked modules AFTER vi.mock calls.
import * as chromeMod from '../chrome.js';
import * as loginMod from '../commands/login.js';
import * as headlessMod from '../login-headless.js';
import * as sessionMod from '../session.js';
import { headlessLoginFromCredentials } from './headless-login.js';

// Minimal fake session for resolved paths.
const FAKE_SESSION = {
  schemaVersion: 2 as const,
  user: { id: 'u1', email: 'dev@example.com' },
  cookies: [],
  origins: [],
  capturedAt: '2026-06-01T00:00:00.000Z',
};

// Fake launched-chrome object.
const fakeLaunched = {
  webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/fake',
  dispose: vi.fn().mockResolvedValue(undefined),
};

// Fake CDP client.
const fakeClient = {
  close: vi.fn().mockResolvedValue(undefined),
};

// Fake attached target.
const fakeAttached = {
  sessionId: 'fake-session-id',
  targetId: 'fake-target-id',
};

beforeEach(() => {
  vi.clearAllMocks();

  // Happy-path defaults — individual tests can override.
  vi.mocked(chromeMod.launchChrome).mockResolvedValue(fakeLaunched as never);
  vi.mocked(cdpMod.CdpClient.connect).mockResolvedValue(fakeClient as never);
  vi.mocked(cdpMod.attachToFirstPage).mockResolvedValue(fakeAttached as never);
  vi.mocked(headlessMod.runHeadlessLogin).mockResolvedValue({ kind: 'ok', stepUp: false });
  vi.mocked(cdpMod.getAllCookies).mockResolvedValue([]);
  vi.mocked(loginMod.resolveUserWithRetry).mockResolvedValue({
    id: 1,
    email: 'dev@example.com',
    name: 'Dev User',
  } as never);
  vi.mocked(sessionMod.writeSession).mockResolvedValue(undefined);
  vi.mocked(sessionMod.readSession).mockResolvedValue(FAKE_SESSION as never);
});

describe('headlessLoginFromCredentials', () => {
  it('returns { kind: "ok" } on the happy path', async () => {
    const result = await headlessLoginFromCredentials({
      email: 'dev@example.com',
      password: 'secret',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.session).toEqual(FAKE_SESSION);
    }
    expect(fakeLaunched.dispose).toHaveBeenCalled();
    expect(fakeClient.close).toHaveBeenCalled();
  });

  it('returns { kind: "failed" } when Chrome is not found', async () => {
    // headlessLoginFromCredentials uses `.catch((err) => err)` on launchChrome,
    // so we simulate Chrome-not-found by resolving with an Error instance that
    // instanceof-checks as ChromeNotFoundError. Since the mock replaces the
    // class, we use a generic Error and rely on the instanceof-Error catch-all
    // branch in headlessLoginFromCredentials.
    const fakeErr = new Error('No Chrome found');
    vi.mocked(chromeMod.launchChrome).mockResolvedValue(fakeErr as never);
    const result = await headlessLoginFromCredentials({
      email: 'dev@example.com',
      password: 'secret',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      // Reason must be a benign label — never expose password/token.
      expect(result.reason).toBe('chrome-launch-failed');
      expect(result.reason).not.toContain('secret');
      expect(result.reason).not.toContain('password');
    }
  });

  it('returns { kind: "failed" } when CDP connect fails', async () => {
    vi.mocked(cdpMod.CdpClient.connect).mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await headlessLoginFromCredentials({
      email: 'dev@example.com',
      password: 'secret',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toBe('cdp-connect-failed');
    }
    // Chrome should be disposed even on CDP connect failure.
    expect(fakeLaunched.dispose).toHaveBeenCalled();
  });

  it('returns { kind: "step-up-needed" } when runHeadlessLogin times out at step-up', async () => {
    vi.mocked(headlessMod.runHeadlessLogin).mockResolvedValue({
      kind: 'timeout',
      stage: 'step-up',
      observedMs: 300_000,
    });
    const result = await headlessLoginFromCredentials({
      email: 'dev@example.com',
      password: 'secret',
    });
    expect(result.kind).toBe('step-up-needed');
  });

  it('returns { kind: "step-up-needed" } when runHeadlessLogin times out at submit', async () => {
    vi.mocked(headlessMod.runHeadlessLogin).mockResolvedValue({
      kind: 'timeout',
      stage: 'submit',
      observedMs: 30_000,
    });
    const result = await headlessLoginFromCredentials({
      email: 'dev@example.com',
      password: 'secret',
    });
    expect(result.kind).toBe('step-up-needed');
  });

  it('returns { kind: "failed" } when runHeadlessLogin returns fallback', async () => {
    vi.mocked(headlessMod.runHeadlessLogin).mockResolvedValue({
      kind: 'fallback',
      reason: 'captcha-detected',
    });
    const result = await headlessLoginFromCredentials({
      email: 'dev@example.com',
      password: 'secret',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toContain('captcha-detected');
      // Reason must never contain the password.
      expect(result.reason).not.toContain('secret');
    }
  });

  it('returns { kind: "failed" } when cookie capture fails', async () => {
    vi.mocked(cdpMod.getAllCookies).mockRejectedValue(new Error('CDP socket closed'));
    const result = await headlessLoginFromCredentials({
      email: 'dev@example.com',
      password: 'secret',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toBe('cookie-capture-failed');
    }
  });

  it('returns { kind: "failed" } when session write fails', async () => {
    vi.mocked(sessionMod.writeSession).mockRejectedValue(new Error('EACCES'));
    const result = await headlessLoginFromCredentials({
      email: 'dev@example.com',
      password: 'secret',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toBe('session-write-failed');
    }
  });

  it('returns { kind: "failed" } when readSession returns null after write', async () => {
    vi.mocked(sessionMod.readSession).mockResolvedValue(null);
    const result = await headlessLoginFromCredentials({
      email: 'dev@example.com',
      password: 'secret',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toBe('session-read-back-failed');
    }
  });
});
