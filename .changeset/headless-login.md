---
'@ait-co/console-cli': patch
---

`aitcc login`이 저장된 자격 증명으로 headless 로그인을 시도하고, step-up 인증이 필요하거나 자격 증명이 없으면 기존 interactive 흐름으로 자동 fallback한다. `--interactive` 플래그로 강제 우회 가능. `--json` 출력에 `mode` (`headless` | `interactive`) 와 `stepUp` 필드 추가.
