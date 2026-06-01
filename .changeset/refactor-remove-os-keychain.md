---
"@ait-co/console-cli": patch
---

refactor(auth): OS keychain 완전 제거 — file-only credential store(~/.config/aitcc/credentials.json, perm 0600)로 통일. 기존 keychain 자격증명은 첫 명령 실행 시 자동 마이그레이션됨.
