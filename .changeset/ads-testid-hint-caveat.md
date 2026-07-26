---
"@ait-co/console-cli": patch
---

fix(ads): `app ads placement-groups create`의 SDK 안내 문구에 실기기 caveat 추가 — "개발 중 테스트는 ait-ad-test-* ID를 쓰세요"만 인쇄하면 테스트 ID가 실기기에서 항상 로드된다는 뜻으로 읽힌다. 2026-07-25/26 env3 실측에서 테스트 ID와 자체 발급 실 지면이 동일하게 `PLACEMENT_ID_FETCH_FAILED`로 실패했으므로, 승인·배포 상태에 따라 테스트 ID도 로드에 실패할 수 있다는 단서를 같은 줄에 덧붙인다. (실패 원인이 승인 게이트인지 `PREPARE` 배포 상태인지는 미해결 — 문구도 단정하지 않는다.)
