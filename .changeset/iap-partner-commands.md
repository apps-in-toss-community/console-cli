---
"@ait-co/console-cli": patch
---

`aitcc app iap` 명령 그룹(`products ls/show/create`, `orders ls`, `refunds ls`)을 추가했다 — 미니앱의 인앱결제 상품 카탈로그·주문·환불을 조회하고, 정적 분석으로 복원한 요청 shape을 바탕으로 상품 등록(`products create`)을 `--dry-run`/`--confirm` 게이트 뒤에서 지원한다. 이 워크스페이스가 파트너(빌링/정산 주체) 미등록 상태라 대부분의 IAP 조회가 `errorCode: 5002`로 막히는데, `hintForErrorCode`가 이 코드를 만나면 `aitcc workspace partner`로 상태를 확인하라는 hint를 `--json` 여부와 무관하게 구조화된 형태로 붙이도록 확장했다.

`aitcc workspace partner`는 `GET .../partner`와 `GET .../partner/is-registered` 두 endpoint를 병렬 호출해 `registered`/`approvalType`/`rejectMessage` 단일 상태 뷰로 병합하도록 바뀌었다(`mergePartnerStates`) — 기존 `--json` 출력 shape은 그대로 유지된다.
