import { sessionPathForDiagnostics } from '../session.js';

// Shared output helpers used by every session-scoped subcommand
// (`workspace`, `app`, and the in-flight `deploy`/`logs`/`members`/`keys`).
// Kept in one place so all commands agree on the `--json` contract — one
// line, trailing \n, stdout for structured output, stderr for diagnostics.

export interface NotAuthenticatedPayload {
  readonly ok: true;
  readonly authenticated: false;
  readonly reason?: 'session-expired';
}

export function emitJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function emitNotAuthenticated(json: boolean, reason?: 'session-expired'): void {
  if (json) {
    // `exactOptionalPropertyTypes` forbids `reason: undefined`, so we omit
    // the key entirely when we don't have a value — hence the branch
    // rather than a single object literal.
    const payload: NotAuthenticatedPayload = reason
      ? { ok: true, authenticated: false, reason }
      : { ok: true, authenticated: false };
    emitJson(payload);
  } else {
    process.stderr.write(
      reason === 'session-expired'
        ? 'Session is no longer valid. Run `aitcc login` again.\n'
        : 'Not logged in. Run `aitcc login` to start a session.\n',
    );
    process.stderr.write(`Session file checked: ${sessionPathForDiagnostics()}\n`);
  }
}

export function emitNetworkError(json: boolean, message: string): void {
  if (json) {
    emitJson({ ok: false, reason: 'network-error', message });
  } else {
    process.stderr.write(`Network error reaching the console API: ${message}.\n`);
  }
}

export function emitApiError(json: boolean, message: string): void {
  if (json) {
    emitJson({ ok: false, reason: 'api-error', message });
  } else {
    process.stderr.write(`Unexpected error: ${message}\n`);
  }
}
