---
"@ait-co/console-cli": patch
---

AI 위험 고지·이용약관(`AI_RISK_USE`) 동의를 aitcc로 처리. `me terms --scope AI_RISK_USE`로 약관을 조회하고 `me terms agree --scope AI_RISK_USE`로 동의한다(법적 동의 게이트 — `contentsUrl`/title 표시 후 인터랙티브 `y/N` 또는 `--json`/non-TTY는 `--yes` 요구, 자동 동의 없음). 계정-level `console-user-terms/me` GET(`?termsScope=AI_RISK_USE`)·POST 엔드포인트를 `src/api/me.ts`에 추가. `keys create`·`app deploy` 등이 errorCode 5010(`혁신금융서비스_약관_미동의`)으로 막히면 `aitcc me terms agree --scope AI_RISK_USE`로 동의하라는 seam hint를 자동 emit.
