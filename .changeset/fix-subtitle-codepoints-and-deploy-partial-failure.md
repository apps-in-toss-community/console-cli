---
"@ait-co/console-cli": patch
---

Fix three correctness/contract bugs found in a cross-repo review sweep:

1. **subtitle length uses codepoints, not UTF-16 units** (`src/config/app-manifest.ts`): `subtitle.length` counted UTF-16 code units, so a valid 20-emoji subtitle (20 codepoints, 40 code units) was wrongly rejected. Now uses `[...subtitle].length` (same approach as the adjacent `description` check).

2. **partial-failure auth error emits `ok: false`** (`src/commands/app-deploy.ts`): when the upload succeeded but the downstream review/release step failed due to a session expiry, the emitter was emitting `ok: true` — making a failed deploy look like a success to `--json` consumers. Changed to `ok: false` while keeping `authenticated: false` and `reason: 'session-expired'` so callers can still distinguish the auth case. Updated the `--json` contract comment to document the corrected shape.

3. **`app-not-found` reason documented but never emitted** (`src/commands/app.ts`): the `--json` contract comment for `app show` promised `{ reason: 'app-not-found' }` at exit 2, but the implementation never emits it — a missing app surfaces via the generic `api-error` handler at exit 17. Corrected the comment to reflect the real behaviour.
