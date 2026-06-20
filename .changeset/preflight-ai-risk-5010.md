---
"@ait-co/console-cli": patch
---

5010(AI 위험 고지·이용약관, `AI_RISK_USE`) 게이트를 에러 전에 선제 감지·안내. `keys create`·`app deploy`가 실 호출 전에 `probeAiRiskTerms`(best-effort, bounded GET)로 동의 상태를 확인해 미동의 시 약관 title·`contentsUrl`과 `aitcc me terms agree --scope AI_RISK_USE` 안내를 stderr로 출력(권위 게이트는 실 API — preflight 실패/timeout은 silent skip 후 진행). `--json`에선 human 경고를 생략해 stdout은 단일 JSON 라인 유지. `app deploy --dry-run`이 그동안 못 보던 5010을 `terms.blockers`(`errorCode 5010`)·경고 열거에 추가. `whoami`에 AI risk 약관 동의 상태 한 줄/`aiRiskTerms` 필드 노출. 막혔을 때 `hintForErrorCode('5010')` 안내를 약관 확인·동의 경로·법적 동의 주의까지 강화(preflight 경고와 remedy 문구 단일 정본 공유).
