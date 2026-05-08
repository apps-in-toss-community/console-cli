---
'@ait-co/console-cli': patch
---

`aitcc workspace terms`가 각 약관이 미동의일 때 어떤 명령이 막히는지 `blocks if missing: …` 한 줄 hint로 표시합니다. JSON에 `blocks` 필드 추가.
