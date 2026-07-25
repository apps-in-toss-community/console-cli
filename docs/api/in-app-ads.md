# In-app advertising (IAA)

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

미니앱의 인앱 광고(IAA) 지면(placement group) 목록·생성과 어뷰징/노출차단 상태 조회 endpoint 묶음. 앱-scope라는 점에서 [`in-app-purchase.md`](./in-app-purchase.md)와 같은 축이고, 워크스페이스 레벨의 "프로모션 머니"([`workspaces.md`](./workspaces.md) "promotion-money")와는 다른 도메인이다 — 프로모션 머니는 워크스페이스가 **자사 앱을 홍보하려고 지출**하는 예산, IAA는 **인앱 광고를 노출해 벌어들이는 수익** 축이다.

**Toss 자동 미디에이션**: 인앱광고 지면 생성에는 개발자의 Google AdMob 계정이 필요 없다 — 미디에이션/waterfall 구성을 Toss가 앱 카테고리 기준으로 자동으로 해 준다(공식문서 + 콘솔 SPA 정적 분석 교차 확인, 2026-07-24, issue #229). 생성 바디에 `mediationGroupId`/`adUnitId`/`spaceUnitId`/`spaceUnitName` 류의 AdMob 키가 전혀 없는 것도 이 때문이다.

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-ads-v2/placement-groups` | 광고 지면 목록 | ✅ confirmed |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-ads-v2/placement-group` | 광고 지면 생성 (단수형 path 주의) | ⚠️ inferred (body) |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-ads-v2/abuse-status` | 어뷰징/노출차단 상태 | ✅ confirmed |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-ads-v2/category/<categoryId>/ad-mob-ad-info/<adFormat>` | 광고 categoryId 유효성 검증 | ✅ confirmed |

## `GET .../in-app-ads-v2/placement-groups` — 광고 지면 목록

- **Used by**: [`src/api/in-app-ads.ts#fetchAdsPlacementGroups`](../../src/api/in-app-ads.ts), `aitcc app ads placement-groups ls`
- **Capture status**: ✅ confirmed (2026-07-24, workspace 3095 / app 31146) — 200, 빈 배열. 아직 이 앱에 등록된 광고 지면이 없다.
- **Auth**: 세션 쿠키

### Response (관측)

```json
{ "resultType": "SUCCESS", "success": [] }
```

지면이 등록된 이후의 entry shape은 미관측 — CLI는 각 항목을 opaque `Record<string, unknown>`로 통과시키고, 사람이 읽는 출력은 `id`/`name`/`status` 필드가 있으면 그것만 best-effort로 뽑아 보여준다 (없으면 `-`).

## `POST .../in-app-ads-v2/placement-group` — 광고 지면 생성

- **Used by**: [`src/api/in-app-ads.ts#createAdsPlacementGroup`](../../src/api/in-app-ads.ts), `aitcc app ads placement-groups create`
- **Capture status**: ⚠️ inferred — request body는 콘솔 SPA의 지면 생성 위저드 폼→바디 직렬화 로직 + 공식문서(`developers-apps-in-toss.toss.im/ads/*`) 교차 확인으로 복원(issue #229). **응답은 물론 request 자체도 라이브로 호출된 적이 없다** (SECRET-HANDLING: 이 endpoint는 read-only가 아니라 실제 광고 지면을 생성하는 mutation이라, 메인테이너 승인 게이트(`--confirm`) 뒤에서만 실행된다).
- **경로 주의**: 목록(`placement-groups`, 복수형)과 달리 생성은 **단수형** `placement-group` path.

### placement-group create — inferred body shape

```ts
{
  displayName: string,                 // 지면 이름, <=40자, 필수
  adFormat: 'BANNER' | 'INTERSTITIAL' | 'REWARDED',   // 필수
  categoryId?: number,                 // adFormat !== 'BANNER'일 때만 필수 (category.id)
  rewardSettings?: { unitType: string, unitAmount: number },  // adFormat === 'REWARDED'일 때만
  adStyles?: ['NORMAL' | 'NATIVE_IMAGE'],  // adFormat === 'BANNER'일 때만, 1개짜리 배열
}
```

- **응답**: 서버 발급 `groupId`(SDK 쪽 `adGroupId`와 동일 개념). 생성 직후 상태는 `state: "REGISTERING"`이고, 구글 광고 시스템 반영까지 **최대 2시간** 걸리는 비동기 처리다.
- **실서빙 게이트**: 지면을 만들었다고 바로 광고가 노출되는 게 아니다 — 사업자 등록·정산 승인이 인앱광고의 선행조건이다(`aitcc workspace business-verification show`로 확인). CLI는 생성 성공 메시지에 이 게이트를 함께 안내한다.
- **SDK 연결**: 생성된 `adGroupId`는 `GoogleAdMob.loadAppsInTossAdMob({ options: { adGroupId } })`로 소비한다. 개발 중 테스트는 실제 지면 없이 `ait-ad-test-interstitial-id` / `ait-ad-test-rewarded-id` / `ait-ad-test-banner-id` / `ait-ad-test-native-image-id` 같은 고정 테스트 ID를 쓸 수 있다(공식문서 확인).

### category 자동 해소 (issue #231, 2026-07-24 실측)

`adFormat !== 'BANNER'`일 때 필요한 `categoryId`는 **미니앱 자신의 category id를 재사용**한다. 앱 상세(`GET .../mini-app/:aid`) 응답의 `miniApp.impression.categoryPaths[0].category.id`가 그 값이다(예: 31146 → `3882`). 유효성은 전용 엔드포인트로 검증한다:

- `GET .../in-app-ads-v2/category/:categoryId/ad-mob-ad-info/:adFormat`
  - valid → `{ resultType: 'SUCCESS', success: { id, categoryId, category } }` (예: cat 3882 → id 179)
  - invalid → `success: { reason: 'not exist category : N' }`
  - cat 0 → `success: null` (placeholder — 실제 카테고리 아님)

따라서 CLI는 `--category`를 **선택 입력**으로 바꿨다: 생략하면 앱 상세에서 category id를 auto-resolve하고 위 엔드포인트로 검증하며, 명시하면 override로 쓴다. 앱 상세에 `categoryPaths`가 없거나 검증이 invalid면 `--category`를 명시하라는 에러로 degrade한다.

> 정정 (issue #229 당시 note): 미니앱 등록용 `impression` 카테고리([`impression.md`](./impression.md))를 광고 `categoryId`와 별개 taxonomy로 추정했으나, 실측 결과 **같은 값**이다 — 광고 `categoryId` = 앱 자신의 impression `category.id`.

## `GET .../in-app-ads-v2/abuse-status` — 어뷰징/노출차단 상태

- **Used by**: [`src/api/in-app-ads.ts#fetchAdsAbuseStatus`](../../src/api/in-app-ads.ts), `aitcc app ads abuse-status`
- **Capture status**: ✅ confirmed (2026-07-24, workspace 3095 / app 31146)
- **Auth**: 세션 쿠키

### Response (관측)

```json
{
  "resultType": "SUCCESS",
  "success": {
    "abuseLevel": "NONE",
    "isServingBlocked": false,
    "blockedPlacementGroups": []
  }
}
```

- `abuseLevel`: 문자열 enum으로 추정 (관측된 값은 `"NONE"`뿐 — 다른 값은 미관측, CLI는 그대로 pass-through).
- `isServingBlocked`: `true`면 광고 노출이 차단된 상태. CLI는 이 경우 콘솔의 광고 정책 위반 안내를 확인하라는 자연어 안내를 덧붙인다.
- `blockedPlacementGroups`: 차단된 지면 목록. 빈 배열만 관측됨 — 항목 shape 미확인.

## 짝 문서

- [`in-app-purchase.md`](./in-app-purchase.md) — 같은 앱-scope 패턴(`workspaces/<wid>/mini-app/<mini_app_id>/...`)을 쓰는 인앱결제 도메인. `products create`도 이번 `placement-groups create`와 같은 "⚠️ inferred body + `--confirm` mutation 게이트" 패턴.
- [`workspaces.md`](./workspaces.md) "promotion-money" — 워크스페이스 레벨의 자사 앱 홍보 지출 축(IAA 수익과는 다른 축이니 혼동 주의).
- [`impression.md`](./impression.md) — 미니앱 등록용 노출 카테고리(`impression.categoryIds`) 조회. 광고 지면의 `categoryId`와는 다른 taxonomy(위 "category 후보 조회" 참고).
- [`workspaces.md`](./workspaces.md) "business-verification" (`aitcc workspace business-verification show`) — 인앱광고 실서빙의 선행조건인 사업자·정산 승인 상태 확인.
