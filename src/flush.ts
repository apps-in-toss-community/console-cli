// Flush-safe exit: drain stdout before calling `process.exit` so a piped
// consumer never loses the final JSON line. Callers typically write the
// JSON payload (or plain-text result) to stdout immediately before
// calling `return exitAfterFlush(code)`.
//
// This is also the single universal chokepoint every command passes through on
// its way out, so it's where the throttled "newer aitcc available?" notice
// runs (a citty `cleanup` hook can't — `process.exit` below pre-empts it). The
// notice is bounded, `--json`-suppressed, and fully defensive; see
// update-notice-hook.ts.

import { runUpdateNoticeOnExit } from './update-notice-hook.js';

export async function exitAfterFlush(code: number): Promise<never> {
  // Surface the update notice (stderr) before draining stdout and exiting.
  // Bounded by an internal 500 ms race and never throws, so it cannot delay or
  // break the exit path.
  await runUpdateNoticeOnExit();
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  process.exit(code);
}
