---
"@ait-co/console-cli": patch
---

fix(app deploy): accept both AIT header format and legacy zip bundles

`@apps-in-toss/web-framework`'s build toolchain switched to an `AIT`
wrapper format (`AITBUNDL` magic + big-endian header + protobuf
`AITBundle` + inner zip blob); legacy toolchains still emit plain zips.
The console's uploader branches on the first 8 bytes and handles both,
but `aitcc app deploy` was parsing the file as a zip unconditionally
and would reject modern bundles with `invalid-zip`.

`src/config/ait-bundle.ts` now:
- detects the format via magic bytes (`AITBUNDL` → AIT, `PK\x03\x04` → zip),
- reads `deploymentId` directly from the AIT protobuf header for AIT
  files (via a minimal inline wire-format decoder — no `protobufjs` /
  `long` runtime dependency), and
- keeps the existing `fflate` `app.json` extraction path for legacy zips.

New `AitBundleErrorReason` values: `unrecognized-format` (neither magic
matches) and `invalid-ait` (truncated or malformed AIT header).
`readAitBundle` / `deploymentIdFromBundleBytes` now also surface the
detected `format: 'ait' | 'zip'`, and `aitcc app deploy --json`
includes `bundleFormat` in both dry-run and success output so
`agent-plugin` can tell which toolchain produced the bundle without
re-reading the file.
