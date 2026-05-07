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

const MISSING_HINT_FULL =
  'libsecret tools are missing. Install `libsecret-tools` (Debian/Ubuntu) or the equivalent and ensure a Secret Service provider (gnome-keyring / KWallet) is running.';
const MISSING_HINT_SHORT =
  'libsecret tools are missing. Install `libsecret-tools` and ensure a Secret Service provider is running.';

export const LINUX_BACKEND: CredentialBackend = {
  name: 'libsecret',
  async get(account) {
    let result: RunResult;
    try {
      result = await runCommand('secret-tool', {
        args: ['lookup', 'service', CREDENTIAL_SERVICE, 'account', account],
      });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError('linux', MISSING_HINT_FULL);
      }
      throw err;
    }
    // `secret-tool lookup` exits 0 with no stdout when the entry is
    // missing on some distros, non-zero on others. Empty stdout = missing
    // either way.
    if (result.stdout.length === 0) return null;
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'secret-tool lookup',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
    const password = stripTrailingNewline(result.stdout);
    return password.length > 0 ? password : null;
  },
  async set(account, password) {
    let result: RunResult;
    try {
      // `store` reads the secret from stdin — keeps argv clean.
      result = await runCommand('secret-tool', {
        args: [
          'store',
          '--label',
          'aitcc Toss Business credentials',
          'service',
          CREDENTIAL_SERVICE,
          'account',
          account,
        ],
        stdin: password,
      });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError('linux', MISSING_HINT_SHORT);
      }
      throw err;
    }
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'secret-tool store',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
  },
  async clear(account) {
    let result: RunResult;
    try {
      result = await runCommand('secret-tool', {
        args: ['clear', 'service', CREDENTIAL_SERVICE, 'account', account],
      });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError('linux', 'libsecret tools are missing.');
      }
      throw err;
    }
    // `secret-tool clear` always exits 0 even when the entry was absent.
    // Probe with `lookup` after to know whether something existed; cheaper
    // alternative is just to report `existed: true` optimistically, since
    // the user-facing impact is "credentials are gone now" either way.
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'secret-tool clear',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
    return { existed: true };
  },
};
