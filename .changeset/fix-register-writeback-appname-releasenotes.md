---
"@ait-co/console-cli": patch
---

fix: three correctness defects — register write-back for string miniAppId, appName validation, empty release-notes guard

- `app register`: `persistMiniAppIdToProject` now coerces a string-typed `miniAppId` (e.g. `"31146"`) returned by the API before the numeric guard, so the write-back to `aitcc.yaml` is no longer skipped when the API returns the id as a string.
- `app-manifest`: `validateManifest` now validates `appName` against `APP_NAME_REGEX` (kebab-case, lowercase-leading), consistent with all other field validations. Invalid slugs throw `ManifestError` with `field: 'appName'`.
- `app deploy`: the `--release-notes` guard now rejects empty strings and whitespace-only values in addition to `undefined`, preventing a silent bypass of the "release notes required" check when `--request-review` is set.
