import {
  CREDENTIAL_SERVICE,
  type CredentialBackend,
  CredentialBackendCommandError,
  CredentialBackendUnsupportedError,
  isCommandNotFound,
  type RunResult,
  redactStderr,
  runCommand,
  stripTrailingNewline,
} from '../backend.js';

const MISSING_HINT = 'macOS `security` is missing from PATH.';

export const MACOS_BACKEND: CredentialBackend = {
  name: 'macos-keychain',
  async get(account) {
    let result: RunResult;
    try {
      result = await runCommand('security', {
        args: ['find-generic-password', '-s', CREDENTIAL_SERVICE, '-a', account, '-w'],
      });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError('darwin', MISSING_HINT);
      }
      throw err;
    }
    if (result.exitCode === 44) return null; // errSecItemNotFound
    if (result.exitCode !== 0) return null; // be lenient on `find` — assume missing
    const password = stripTrailingNewline(result.stdout);
    return password.length > 0 ? password : null;
  },
  async set(account, password) {
    let result: RunResult;
    try {
      // -U upserts. -A opens the ACL so subsequent `find-generic-password`
      // reads do not raise the keychain unlock prompt every call (saving
      // one prompt per `aitcc` run, including the read inside the
      // unchanged-detection path of `saveCredentials`). The trade-off is a
      // permissive ACL: any process running as the same user can read the
      // entry. We accept this for the same reason we accept argv-visible
      // passwords on `security` — the threat model is a single-user
      // machine and the OS keychain is no stronger than the login
      // session. `security` reads the password from `-w`; no stdin path
      // exists on this command.
      result = await runCommand('security', {
        args: [
          'add-generic-password',
          '-U',
          '-A',
          '-s',
          CREDENTIAL_SERVICE,
          '-a',
          account,
          '-w',
          password,
        ],
      });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError('darwin', MISSING_HINT);
      }
      throw err;
    }
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'security add-generic-password',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
  },
  async clear(account) {
    let result: RunResult;
    try {
      result = await runCommand('security', {
        args: ['delete-generic-password', '-s', CREDENTIAL_SERVICE, '-a', account],
      });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError('darwin', MISSING_HINT);
      }
      throw err;
    }
    if (result.exitCode === 44) return { existed: false };
    if (result.exitCode === 0) return { existed: true };
    throw new CredentialBackendCommandError(
      'security delete-generic-password',
      result.exitCode,
      redactStderr(result.stderr),
    );
  },
};
