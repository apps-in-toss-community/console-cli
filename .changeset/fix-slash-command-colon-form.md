---
'@ait-co/console-cli': patch
---

문서·주석에서 잘못된 슬래시 명령 표기 `/ait <verb>`(공백)를 `/ait:<verb>`(콜론)로 수정

agent-plugin 설치 시 플러그인 이름이 명령 네임스페이스가 되므로 실제 형태는 콜론이다 — 공백 형태는 `Unknown command: /ait`만 낸다. `CLAUDE.md`와 `src/commands/keys.ts`의 `--json` 계약 주석에 남아 있던 잘못된 표기를 바로잡았다. 동작 변화 없음.
