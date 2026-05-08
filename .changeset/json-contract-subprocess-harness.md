---
'@ait-co/console-cli': patch
---

`--json` 계약을 subprocess 레벨에서 검증하는 vitest harness를 확장. built CLI를 spawn해 stdout이 단일-라인 JSON임을 자동 보증하고 stderr에 JSON이 새지 않는지 점검한다. workspace/whoami/app/logout/auth/--version/unknown-command 12개 케이스. 사용자에게 보이는 동작 변경은 없다.
