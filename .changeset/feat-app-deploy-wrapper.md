---
"@ait-co/console-cli": patch
---

feat(app): deploy one-shot wrapper (upload + review + release)

Adds `aitcc app deploy <path> --app <id>` — a convenience wrapper that
chains the bundle pipeline. Before this, shipping a bundle meant
running three separate commands (`bundles upload` → `bundles review` →
`bundles release`) while carrying the same `--deployment-id` by hand.

The wrapper:

- Auto-detects `_metadata.deploymentId` from the `.ait` by cracking the
  zip (via `fflate`) when `--deployment-id` is omitted — users no
  longer need to open the bundle themselves.
- Always performs the 3-step upload (initialize → PUT → complete, +
  optional memo).
- `--request-review --release-notes <text>` additionally submits the
  bundle for review.
- `--release --confirm` additionally publishes an APPROVED bundle.
  (Typically a second `app deploy` run, since a freshly uploaded
  bundle is not yet APPROVED.)
- `--dry-run` prints the planned pipeline without touching the server.
- Partial-success `--json` reports `uploaded`/`reviewed`/`released`
  flags so `agent-plugin` can resume at the failing step on retry
  without re-uploading.

Internal additions:

- New runtime dependency: `fflate` (~8 KB, zero deps) for zip reads.
- New module: `src/config/ait-bundle.ts` — pure bundle reader, unit-
  tested with synthesized zips (`src/config/ait-bundle.test.ts`).
- New command module: `src/commands/app-deploy.ts`, exporting
  `runDeploy` as the testable seam (same pattern as `runRegister`).
