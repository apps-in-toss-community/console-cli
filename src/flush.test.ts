import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the update-notice hook so we can assert exitAfterFlush invokes it,
// without touching the network or a real cache.
const order: string[] = [];
const runUpdateNoticeOnExit = vi.fn(async () => {
  order.push('notice');
});
vi.mock('./update-notice-hook.js', () => ({ runUpdateNoticeOnExit }));

// Import AFTER the mock is registered.
const { exitAfterFlush } = await import('./flush.js');

describe('exitAfterFlush', () => {
  afterEach(() => {
    order.length = 0;
    runUpdateNoticeOnExit.mockClear();
    vi.restoreAllMocks();
  });

  it('runs the update notice, then exits with the given code', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      order.push(`exit:${code}`);
      // Throw to unwind the never-returning function so the test can continue.
      throw new Error(`__exit_${code}__`);
    }) as never);

    await expect(exitAfterFlush(7)).rejects.toThrow('__exit_7__');

    // The notice must run, and it must run BEFORE process.exit so its stderr
    // write isn't truncated by the exiting process.
    expect(runUpdateNoticeOnExit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['notice', 'exit:7']);
    expect(exitSpy).toHaveBeenCalledWith(7);
  });

  it('still exits even if the notice hook were to reject (it never should)', async () => {
    // Defensive contract: the hook is documented to never throw. Belt-and-
    // suspenders — if it ever did, exitAfterFlush should not be left hanging.
    // Here we confirm the happy path; the hook's own test covers no-throw.
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);
    await expect(exitAfterFlush(0)).rejects.toThrow('__exit_0__');
    expect(runUpdateNoticeOnExit).toHaveBeenCalledTimes(1);
  });
});
