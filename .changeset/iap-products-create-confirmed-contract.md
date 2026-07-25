---
"@ait-co/console-cli": patch
---

`aitcc app iap products create`의 생성 계약을 2026-07-25 콘솔 SPA 재측정 결과(issue #232)에 맞춰 갱신했다. 플래그를 `--icon-img-url`→`--icon`, `--min-deployment-id`→`--min-deployment`, `--post-inspection-status <S>`→`--expose`(불리언)로 정리하고, `--price`는 10원 단위로 스냅해 범위를 검증하며 스냅 시 경고를 낸다(`warnings` — json/stderr). `--renewal-cycle`/`--discount`는 `--type SUBSCRIPTION`이 아니면 조용히 버리지 않고 거부한다(fail fast). `--discount <spec>`을 새로 지원한다 — citty(0.2.2)에 반복 플래그를 배열로 모으는 기능이 없어 `;`-구분 다중 entry를 담는 단일 플래그로 구현(`FREE_TRIAL`/`NEW_SUBSCRIPTION`/`RETURNING` discountPolicies 조립, `src/commands/app-iap.ts#parseDiscountPoliciesSpec`).

`--confirm` 경로는 실제 POST 전에 read-only `catalogs` preflight를 거쳐, `errorCode: 5001`(IAP 위탁매매 약관 미동의)을 만나면 POST를 시도하지 않고 `aitcc workspace terms --type IAP`를 가리키는 힌트로 중단한다(`hintForErrorCode`에 5001 케이스 추가 — 동의는 법적 결정이라 CLI가 대신 처리하지 않음). `--min-deployment`의 APPROVED-배포 검증은 클라이언트에서 확정 관측된 API 응답이 없어 follow-up으로 남겼다(플래그 존재 여부만 검증, help text에 명시).

`app ads placement-groups create`보다 강한 게이트(생성 = 심사 제출)라는 점을 명령 설명·거부 메시지에 명시했고, 성공 출력에 "노출은 심사 APPROVED 후"와 SDK 소비 힌트(`IAP.getProductItemList()` → `createOneTimePurchaseOrder`)를 추가했다. `docs/api/in-app-purchase.md`의 "products create" 섹션을 ⚠️ inferred에서 ✅ confirmed로 갱신 — 승인 전 create는 광고와 달리 막힐 개연성이 높다는 점을 명시.
