---
"@ait-co/console-cli": patch
---

수익화 상태를 조회하는 read-only 명령 5종을 추가했다: `aitcc app ads placement-groups ls` / `aitcc app ads abuse-status`(인앱 광고 지면·어뷰징 상태), `aitcc app pay-config show`(토스페이 키 설정 상태), `aitcc workspace promotion-money show`(자사 앱 홍보 지출 축 — IAA 광고수익과는 다른 축), `aitcc workspace business-verification show`(사업자 라이선스 인증 + 파트너 등록 상태를 한 리포트로). 전부 2026-07-24 라이브 200 응답으로 확정된 엔드포인트(workspace 3095 / app 31146)를 기반으로 한다.

`aitcc app pay-config show`는 5개 토스페이 자격증명 필드(`payApiKey`/`testPayApiKey`/`billingPayApiKey`/`testBillingPayApiKey`/`tossCertClientId`)의 값을 API 레이어에서부터 `'SET'|'UNSET'`으로만 마스킹한다 — Deploy Key와 동일한 시크릿 취급 원칙이며, `--json`을 포함한 어떤 출력 경로에도 원시 값이 노출되지 않는다. `aitcc workspace business-verification show`가 관측한 사업자 라이선스 미등록 신호(`errorCode: 500`)는 HTTP 실패가 아니라 SUCCESS envelope 안에 nest된 business-level 필드라, 에러로 죽지 않고 진단 메시지로 렌더링한다.
