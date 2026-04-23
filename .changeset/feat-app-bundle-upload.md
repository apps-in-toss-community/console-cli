---
"@ait-co/console-cli": patch
---

feat(app): bundle upload/review/release/test-push commands

Adds the full write-path for shipping bundles to mini-apps:

- `aitcc app bundles upload <id> <path> --deployment-id <uuid> [--memo]` —
  3-step deploy dance observed in the console UI:
  `POST /deployments/initialize {deploymentId}` →
  `PUT <uploadUrl>` (S3 presigned, Content-Type `application/zip`) →
  `POST /deployments/complete {deploymentId}` →
  optional `POST /bundles/memos {deploymentId, memo}`.
  Refuses if initialize returns `reviewStatus !== PREPARE` (matches the
  console's "이미 존재하는 버전이에요." guard). `--dry-run` shows what
  would be sent without touching the server.
- `aitcc app bundles review <id> --deployment-id <uuid> --release-notes <text>` —
  `POST /bundles/reviews`. `--withdraw` sends
  `POST /bundles/reviews/withdrawal` instead.
- `aitcc app bundles release <id> --deployment-id <uuid> --confirm` —
  `POST /bundles/release`. Guarded behind `--confirm` because the bundle
  goes live to end users.
- `aitcc app bundles test-push <id> --deployment-id <uuid>` —
  `POST /bundles/test-push`.
- `aitcc app bundles test-links <id>` — `GET /bundles/test-links`.

`deploymentId` is the `_metadata.deploymentId` written into the `.ait`
bundle's `app.json` by the build toolchain; for now the CLI takes it as
an explicit flag. Zip cracking is a follow-up.
