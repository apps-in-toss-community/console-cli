// Flush-safe exit: drain stdout before calling `process.exit` so a piped
// consumer never loses the final JSON line. Callers typically write the
// JSON payload (or plain-text result) to stdout immediately before
// calling `return exitAfterFlush(code)`.

export async function exitAfterFlush(code: number): Promise<never> {
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  process.exit(code);
}
