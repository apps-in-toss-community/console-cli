---
'@ait-co/console-cli': patch
---

Recognize prefix-form `errorCode` values (`<domain>.<Reason>`, e.g. `miniApp.InvalidTitle`) emitted by `POST /workspaces/:wid/mini-app/review` alongside the legacy numeric codes. Known prefix codes are mapped to a one-line user action in `--json` and stderr output (raw `errorCode` is preserved); unknown prefix codes surface the dotted identifier so it can be looked up in `docs/api/_error-codes.md`. Numeric codes (`4046` / `4032` / `4010` / …) keep existing behaviour byte-for-byte. Discovered during sdk-example#39 dog-food.
