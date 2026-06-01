---
"@ait-co/console-cli": patch
---

`keys create` now automatically saves the issued Deploy Key to `~/.ait/credentials` under the `--name` profile so `ait deploy --profile <name>` works immediately without a separate `ait token add` step. Pass `--no-save-profile` to skip (stdout-only, for CI pipes). Also fixes the `~/.ait` directory permissions to `0700` (was missing mode, defaulted to `0755`).
