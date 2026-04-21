// Centralized exit codes so every command and the agent-plugin side agree.

export const ExitCode = {
  Ok: 0,
  Generic: 1,
  Usage: 2,
  NotAuthenticated: 10,
  NetworkError: 11,
  LoginTimeout: 12,
  // Reserved historical slot (was LoginStateMismatch under the OAuth
  // callback flow). Unused by the CDP login path but kept stable so the
  // agent-plugin side doesn't need to renumber.
  LoginStateMismatch: 13,
  LoginBrowserNotFound: 14,
  LoginBrowserFailed: 15,
  LoginCookieCaptureFailed: 16,
  ApiError: 17,
  UpgradeUnavailable: 20,
  UpgradeAlreadyLatest: 21,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
