---
'@ait-co/console-cli': patch
---

`aitcc keys create --name <label> [--apps <slug,slug>]` / `aitcc keys revoke <id>` 추가. 발급 응답의 plaintext key는 stdout에 한 번만 surface되고 list endpoint는 이를 echo하지 않으므로 즉시 secret manager에 저장해야 합니다 (`aitcc keys create --json`을 keychain pipe에 직접 연결). `keys ls`도 confirmed shape(`{id, name, expireTs}`)에 맞춰 D-N expiry 컬럼을 추가했습니다. endpoint/payload 상세는 `docs/api/api-keys.md`.
