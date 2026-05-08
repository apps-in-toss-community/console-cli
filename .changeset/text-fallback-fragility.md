---
"@ait-co/console-cli": patch
---

Drop the `type=text` fallback from the headless login email-input picker. If a search box or other unrelated text input were rendered above the sign-in form, the previous fallback would have silently typed the email and password into it in plaintext. The picker now matches by `name` (`email`/`loginId`/`username`) and falls back only to `type=email`, which is semantically unambiguous.
