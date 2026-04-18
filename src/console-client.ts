// STUB — HTTP client for the Apps in Toss developer console.
//
// This file intentionally does not make any real network calls yet. It is a
// seam for the future `login` / `deploy` / `logs` commands. Everything here
// is placeholder logic so the rest of the CLI (whoami, upgrade) can compile
// against a real module shape instead of an `unknown` blob.
//
// When login lands, this module will:
//   1. Accept a `Session` and construct an authenticated Playwright context
//      (cookies + origins from `storageState`).
//   2. Expose `fetchProjects()`, `deploy(path)`, `tailLogs(appId)` etc.
//
// NOTHING HERE CALLS TOSS. Do not add real endpoints without a design review.

import type { Session } from './session.js';

export interface ConsoleClient {
  readonly authenticatedAs: string;
}

export function createConsoleClient(session: Session): ConsoleClient {
  // Only `user.id` leaves this module — see session.ts for why the rest is
  // treated as secret material.
  return { authenticatedAs: session.user.id };
}
