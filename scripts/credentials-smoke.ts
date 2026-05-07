#!/usr/bin/env bun
/// <reference types="bun" />

// PR α smoke test: round-trip credentials through the OS keychain inside a
// `bun build --compile` binary. Not part of the shipped CLI — purely a dev
// verification harness so we know the spawn() + node:fs/promises code paths
// survive Bun's bundler and run against the real native tooling
// (`security` / `secret-tool` / PowerShell) on the host platform.
//
// Usage:
//   bun run scripts/credentials-smoke.ts          # source-form
//   ./dist-bin/credentials-smoke                  # compiled binary
//
// The script uses a unique XDG_CONFIG_HOME and a unique account label
// (`smoke-<timestamp>@aitcc.local`) so it cannot collide with the user's
// real credential entry. Cleanup is best-effort but always runs.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteCredentials, loadCredentials, saveCredentials } from '../src/auth/credentials.js';

function fail(msg: string): never {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

const xdg = mkdtempSync(join(tmpdir(), 'aitcc-cred-smoke-'));
process.env.XDG_CONFIG_HOME = xdg;

const account = `smoke-${Date.now()}@aitcc.local`;
const password = `pw-${Math.random().toString(36).slice(2)}`;

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  try {
    await deleteCredentials();
  } catch {
    // Best-effort.
  }
  try {
    rmSync(xdg, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
}

process.on('exit', () => {
  // Synchronous-only cleanup at this point; rmSync is fine, deleteCredentials
  // is async so we rely on the explicit cleanup() call in main().
  try {
    rmSync(xdg, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function main(): Promise<void> {
  console.log(`[smoke] platform=${process.platform} bun=${typeof Bun !== 'undefined'}`);
  console.log(`[smoke] xdg=${xdg}`);
  console.log(`[smoke] account=${account}`);

  // 1. save (created)
  const created = await saveCredentials(account, password);
  if (created.status !== 'created') fail(`expected created, got ${created.status}`);
  console.log('[smoke] save#1 status=created');

  // 2. load (keychain)
  const loaded = await loadCredentials();
  if (!loaded || loaded.kind !== 'keychain') fail(`expected kind=keychain, got ${loaded?.kind}`);
  if (loaded.email !== account) fail(`email mismatch: ${loaded.email}`);
  if (loaded.password !== password) fail('password mismatch');
  console.log('[smoke] load kind=keychain ✓');

  // 3. save same value again (unchanged — no keychain write)
  const same = await saveCredentials(account, password);
  if (same.status !== 'unchanged') fail(`expected unchanged, got ${same.status}`);
  console.log('[smoke] save#2 status=unchanged ✓');

  // 4. save new password (updated)
  const newPw = `${password}-v2`;
  const updated = await saveCredentials(account, newPw);
  if (updated.status !== 'updated') fail(`expected updated, got ${updated.status}`);
  const reloaded = await loadCredentials();
  if (!reloaded || reloaded.password !== newPw) fail('password did not update');
  console.log('[smoke] save#3 status=updated ✓');

  // 5. env path overrides keychain
  const envLoaded = await loadCredentials({
    env: { AITCC_EMAIL: 'env@example.com', AITCC_PASSWORD: 'env-pw' },
  });
  if (!envLoaded || envLoaded.kind !== 'env') fail(`expected kind=env, got ${envLoaded?.kind}`);
  console.log('[smoke] env priority ✓');

  // 6. delete
  const del = await deleteCredentials();
  if (!del.existed) fail('delete did not report existed=true');
  const afterDel = await loadCredentials({ env: {} });
  if (afterDel !== null) fail('still have credentials after delete');
  console.log('[smoke] delete ✓');

  console.log('[smoke] ALL OK');
}

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error('[smoke] unhandled error:', err);
    await cleanup();
    process.exit(1);
  });
