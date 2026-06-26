---
"@ait-co/console-cli": patch
---

업데이트 notice("newer aitcc available")를 `whoami`뿐 아니라 **모든 명령**에서 띄운다. probe를 단일 종료 chokepoint(`exitAfterFlush`)로 옮겨, `aitcc app deploy`·`app status` 등 어떤 명령을 돌려도 24h 스로틀 안에서 한 번 notice를 본다. non-TTY(agent/CI)·`--json` 출력·`upgrade`/`completion`은 그대로 침묵. self-update 동작은 변경 없음(notify-only).
