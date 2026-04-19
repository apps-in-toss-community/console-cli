// Centralized exit codes so every command and the agent-plugin side agree.

export const ExitCode = {
  Ok: 0,
  Generic: 1,
  Usage: 2,
  NotAuthenticated: 10,
  NetworkError: 11,
  LoginTimeout: 12,
  LoginStateMismatch: 13,
  UpgradeUnavailable: 20,
  UpgradeAlreadyLatest: 21,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
