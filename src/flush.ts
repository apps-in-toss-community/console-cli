// Flush-safe exit: drain stdout before calling `process.exit` so a piped
// consumer never loses the final JSON line. Callers typically write the
// JSON payload (or plain-text result) to stdout immediately before
// calling `return exitAfterFlush(code)`.
//
// This is also the single universal chokepoint every command passes through on
// its way out, so it's where the throttled "newer aitcc available?" notice and
// the one-time completion-hint run (citty `cleanup` hooks can't — `process.exit`
// below pre-empts them). Both hooks are bounded, `--json`-suppressed, and fully
// defensive; see update-notice-hook.ts and completion-hint.ts.

import { maybeSuggestCompletionOnExit } from './completion-hint.js';
import { runUpdateNoticeOnExit } from './update-notice-hook.js';

export async function exitAfterFlush(code: number): Promise<never> {
  // Surface the update notice (stderr) before draining stdout and exiting.
  // Bounded by an internal 500 ms race and never throws, so it cannot delay or
  // break the exit path.
  await runUpdateNoticeOnExit();
  // One-time completion-hint: suggest installing shell tab-completion if not
  // already installed and not yet suggested. Runs after the update notice so
  // the two hints don't visually collide. Bounded by a couple of fs ops and
  // never throws.
  await maybeSuggestCompletionOnExit();
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  process.exit(code);
}
