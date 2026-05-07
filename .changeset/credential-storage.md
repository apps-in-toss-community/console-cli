---
'@ait-co/console-cli': patch
---

Add `src/auth/credentials.ts` library for persisting Toss Business email + password across the OS keychain (macOS `security`, Linux `secret-tool`, Windows PowerShell + CredWrite). `loadCredentials()` resolves from `AITCC_EMAIL`+`AITCC_PASSWORD` env first, then falls back to the keychain entry pointed to by `auth-state.json`. `saveCredentials()` is no-op (`status: 'unchanged'`) when the same email + password is already stored. Library only — no CLI surface yet; wiring into the form-fill login path lands in a follow-up PR.
