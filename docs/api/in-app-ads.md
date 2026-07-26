# In-app advertising (IAA)

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

미니앱의 인앱 광고(IAA) 지면(placement group) 목록·생성과 어뷰징/노출차단 상태 조회 endpoint 묶음. 앱-scope라는 점에서 [`in-app-purchase.md`](./in-app-purchase.md)와 같은 축이고, 워크스페이스 레벨의 "프로모션 머니"([`workspaces.md`](./workspaces.md) "promotion-money")와는 다른 도메인이다 — 프로모션 머니는 워크스페이스가 **자사 앱을 홍보하려고 지출**하는 예산, IAA는 **인앱 광고를 노출해 벌어들이는 수익** 축이다.

**Toss 자동 미디에이션**: 인앱광고 지면 생성에는 개발자의 Google AdMob 계정이 필요 없다 — 미디에이션/waterfall 구성을 Toss가 앱 카테고리 기준으로 자동으로 해 준다(공식문서 + 콘솔 SPA 정적 분석 교차 확인, 2026-07-24, issue #229). 생성 바디에 `mediationGroupId`/`adUnitId`/`spaceUnitId`/`spaceUnitName` 류의 AdMob 키가 전혀 없는 것도 이 때문이다. 2026-07-26 목록 캡처가 이를 뒷받침한다 — 그런 키를 하나도 보내지 않고 만든 지면인데도 저장된 리소스엔 `adUnitId`와 mediation 워터폴(`mediationGroupLines`)이 서버측에서 채워져 있다.

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-ads-v2/placement-groups` | 광고 지면 목록 | ✅ confirmed |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-ads-v2/placement-group` | 광고 지면 생성 (단수형 path 주의) | ⚠️ inferred (body) |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-ads-v2/abuse-status` | 어뷰징/노출차단 상태 | ✅ confirmed |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-ads-v2/category/<categoryId>/ad-mob-ad-info/<adFormat>` | 광고 categoryId 유효성 검증 | ✅ confirmed |

## `GET .../in-app-ads-v2/placement-groups` — 광고 지면 목록

- **Used by**: [`src/api/in-app-ads.ts#fetchAdsPlacementGroups`](../../src/api/in-app-ads.ts), `aitcc app ads placement-groups ls`
- **Capture status**: ✅ confirmed — 빈 목록(2026-07-24, workspace 3095 / app 31146: 200 + 빈 배열)에 이어 **채워진 목록도 캡처**(2026-07-26, 같은 워크스페이스/앱: 200 + 지면 4건). entry shape은 아래 참조.
- **Auth**: 세션 쿠키

### Response — 빈 목록 (관측 2026-07-24)

```json
{ "resultType": "SUCCESS", "success": [] }
```

### Response — 지면 4건 (관측 2026-07-26)

`success`는 페이지네이션 wrapper 없는 **평평한 배열**이다. 2026-07-24에 생성한 4건이 모두 `state: "ENABLED"`로 조회된다:

| groupId | adFormat | adStyles | rewardSettings | iosPlacement | androidPlacement | regTs |
|---|---|---|---|---|---|---|
| `ait.v2.live.f75ef8504e254b11` | `INTERSTITIAL` | `["MOMENT","MOMENT_VIDEO","BRAND"]` | `null` | 있음 | 있음 | `2026-07-24T03:29:37` |
| `ait.v2.live.4ebc5e0284164325` | `REWARDED` | `["MOMENT_VIDEO"]` | `{"unitAmount":1,"unitType":"포인트"}` | 있음 | 있음 | `2026-07-24T13:08:47` |
| `ait.v2.live.934f395bb2b44754` | `BANNER` | `["NORMAL"]` | `null` | **`null`** | **`null`** | `2026-07-24T13:08:48` |
| `ait.v2.live.8e3e176e1b224c7f` | `BANNER` | `["NATIVE_IMAGE"]` | `null` | **`null`** | **`null`** | `2026-07-24T13:08:49` |

4건 모두 `regTs === updTs`다 — 다만 `updTs`가 서버측 변이를 신뢰성 있게 반영하는 필드인지는 확인되지 않았다(아래 "콘솔 쪽 대조로 좁혀진 범위" 참고). 그 외 공통: `scheduledDelTs: null`, `report: null`, `abuseLevel: "NONE"`.

**BANNER의 placement 비대칭**: INTERSTITIAL/REWARDED는 iOS·Android 양쪽에 AdMob placement + mediation 워터폴이 채워져 있는데, BANNER 2건은 두 플랫폼 placement가 모두 `null`이다 — REWARDED 지면과 1~2초 간격으로 연달아 생성됐는데도 그렇다. 즉 `state: "ENABLED"`가 곧 "양 플랫폼 지면 프로비저닝 완료"를 뜻하지 않는다. 배너 계열이 비동기 프로비저닝을 더 기다리는 것인지, 포맷별로 절차가 다른 것인지는 미확인 — 재관측 대상.

### Entry shape (관측된 키 순서)

값은 대부분 placeholder다: `appPlacementId`/`adUnitId`/`mediationGroupId`/`adSourceId`/`cpmMicros`와 mediation line의 id·`displayName`(중개 파트너사명)은 **토스 쪽 광고 수익화 설정**이라 필드 이름·타입만 남기고 실값은 싣지 않는다. `groupId`·`adFormat`·`adStyles`·`state`·`category`·`rewardSettings`·타임스탬프는 앱 소유자의 자기 설정이라 그대로 둔다.

```ts
{
  groupId: string,                 // 'ait.v2.live.<hex16>' — SDK의 adGroupId와 동일 값
  name: string,
  categoryId: number,              // 31146 → 3882 (앱 자신의 impression category — 아래 "category 자동 해소")
  category: {
    categoryGroup: { id: number, name: string, isSelectable: boolean },   // 31146 → id 7 '생활'
    category:      { id: number, name: string, isSelectable: boolean },   // 31146 → id 3882 '정보'
  },
  adFormat: 'BANNER' | 'INTERSTITIAL' | 'REWARDED',
  adStyles: string[],              // 관측: ['MOMENT','MOMENT_VIDEO','BRAND'] | ['MOMENT_VIDEO'] | ['NORMAL'] | ['NATIVE_IMAGE']
  displayName: string,
  state: string,                   // 관측된 값은 'ENABLED'뿐 — 생성 직후 'REGISTERING'이 존재하는지는 추정이고 라이브 미관측(아래 "광고 지면 생성" 참고)
  rewardSettings: { unitAmount: number, unitType: string } | null,   // REWARDED에만, 그 외 null
  iosPlacement: Placement | null,      // BANNER 2건은 null
  androidPlacement: Placement | null,  // 동일
  report: null,                    // 4건 모두 null — 채워진 형태 미관측
  regTs: string,                   // 'YYYY-MM-DDTHH:mm:ss' (타임존 suffix 없음)
  updTs: string,
  scheduledDelTs: string | null,
  abuseLevel: string,              // 4건 모두 'NONE' — abuse-status의 앱 레벨 값과 같은 enum으로 보임
}

// iosPlacement / androidPlacement
type Placement = {
  appPlacementId: number,          // <int> — redact
  adFormat: string,                // group의 adFormat과 동일
  adUnitId: string,                // 'ca-app-pub-<publisher>/<unit>' 형태 — redact
  mediationGroupId: number,        // <int> — redact
  mediationGroup: {
    mediationGroupId: number,
    targeting: {
      excludedRegionCodes: null,   // 4건 모두 null — 채워진 형태 미관측
      targetedRegionCodes: null,
      idfaTargeting: string,       // 관측: 'AVAILABLE'
    },
    adSources: null,               // 4건 모두 null
    mediationGroupLines: {         // 배열이 아니라 lineId를 키로 쓰는 map
      [lineId: string]: {
        id: string,                // '<string>' — redact
        displayName: string,       // 중개 파트너사명 — redact
        adSourceId: string,        // '<string>' — redact
        cpmMode: 'LIVE' | 'MANUAL',
        cpmMicros: string | null,  // '<string>' — redact (문자열로 옴, 숫자 아님)
        state: string,
        experimentVariant: string,
      },
    },
  },
}
```

CLI는 이 shape을 타입으로 강제하지 않는다 — 각 항목을 opaque `Record<string, unknown>`로 통과시키고, 사람이 읽는 출력은 `id`/`name`/`status` 필드가 있으면 그것만 best-effort로 뽑아 보여준다 (없으면 `-`). 실제 응답의 키는 `groupId`/`name`/`state`라 현재 사람이 읽는 출력에서 id와 status 칸이 `-`로 비는데, 이 표시 로직 보정은 CLI 쪽 follow-up이다(문서 shape은 위가 정본).

## `POST .../in-app-ads-v2/placement-group` — 광고 지면 생성

- **Used by**: [`src/api/in-app-ads.ts#createAdsPlacementGroup`](../../src/api/in-app-ads.ts), `aitcc app ads placement-groups create`
- **Capture status**: ⚠️ inferred — request body는 콘솔 SPA의 지면 생성 위저드 폼→바디 직렬화 로직 + 공식문서(`developers-apps-in-toss.toss.im/ads/*`) 교차 확인으로 복원(issue #229). **갱신 (2026-07-25/26)**: 이 endpoint는 실제로 31146에 대해 라이브로 호출돼, 광고 지면 4개(interstitial `ait.v2.live.f75ef8504e254b11`, rewarded `ait.v2.live.4ebc5e0284164325` 포함)가 생성됐다 — 메인테이너 승인 게이트(`--confirm`) 뒤에서 실행(SECRET-HANDLING: read-only가 아니라 실제 광고 지면을 생성하는 mutation이라는 원칙은 유지). 다만 **create 응답 본문**(`groupId`/`state` 등)은 아직 캡처하지 못했다 — follow-up. **저장된 리소스의 shape은 2026-07-26 `ls` 캡처로 확정됐지만**(위 "Entry shape"), 그게 곧 create가 그 자리에서 돌려주는 envelope은 아니다 — 서버가 전체 리소스를 그대로 echo하는지, `groupId`만 돌려주는지, 생성 직후 `state`가 `REGISTERING`인지는 여전히 미관측이다.
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

- **응답**: 서버 발급 `groupId`(SDK 쪽 `adGroupId`와 동일 개념). 생성 직후 `state`가 `"REGISTERING"`인지는 **추정이며 라이브 미관측**이다 — repo 안에서 이 값은 테스트 mock(`src/api/in-app-ads.test.ts`)에서만 등장하고 공식문서·라이브 캡처 어디에도 근거가 없다. 한편 구글 광고 시스템 반영까지 **최대 2시간** 걸릴 수 있다는 점은 공식 개발자 문서(`developers-apps-in-toss.toss.im/ads/intro.html`, "광고 그룹 ID는 구글에 등록되기까지 최대 2시간이 걸릴 수 있어요")에 명시돼 있다 — 출처 기반, 라이브 미관측.
- **실서빙 게이트**: 지면을 만들었다고 바로 광고가 노출되는 게 아니다 — 사업자 등록·정산 승인이 인앱광고의 선행조건이다(`aitcc workspace business-verification show`로 확인). CLI는 생성 성공 메시지에 이 게이트를 함께 안내한다.
- **SDK 연결**: 생성된 `adGroupId`는 `GoogleAdMob.loadAppsInTossAdMob({ options: { adGroupId } })`로 소비한다. 개발 중 테스트는 실제 지면 없이 `ait-ad-test-interstitial-id` / `ait-ad-test-rewarded-id` / `ait-ad-test-banner-id` / `ait-ad-test-native-image-id` 같은 고정 테스트 ID를 쓸 수 있다(공식문서 확인) — 실기기 서빙은 아래 "SDK 측 실서빙 관측" 참고.

### category 자동 해소 (issue #231, 2026-07-24 실측)

`adFormat !== 'BANNER'`일 때 필요한 `categoryId`는 **미니앱 자신의 category id를 재사용**한다. 앱 상세(`GET .../mini-app/:aid`) 응답의 `miniApp.impression.categoryPaths[0].category.id`가 그 값이다(예: 31146 → `3882`). 유효성은 전용 엔드포인트로 검증한다:

- `GET .../in-app-ads-v2/category/:categoryId/ad-mob-ad-info/:adFormat`
  - valid → `{ resultType: 'SUCCESS', success: { id, categoryId, category } }` (예: cat 3882 → id 179)
  - invalid → `success: { reason: 'not exist category : N' }`
  - cat 0 → `success: null` (placeholder — 실제 카테고리 아님)

따라서 CLI는 `--category`를 **선택 입력**으로 바꿨다: 생략하면 앱 상세에서 category id를 auto-resolve하고 위 엔드포인트로 검증하며, 명시하면 override로 쓴다. 앱 상세에 `categoryPaths`가 없거나 검증이 invalid면 `--category`를 명시하라는 에러로 degrade한다.

> 정정 (issue #229 당시 note): 미니앱 등록용 `impression` 카테고리([`impression.md`](./impression.md))를 광고 `categoryId`와 별개 taxonomy로 추정했으나, 실측 결과 **같은 값**이다 — 광고 `categoryId` = 앱 자신의 impression `category.id`.

## SDK 측 실서빙 관측 (env3 실기기, 2026-07-25/26)

이 섹션은 콘솔 API surface 밖의 관측이다 — SDK(`GoogleAdMob`)가 실기기에서 광고를 로드/노출하는 동작이라 위 콘솔 endpoint들과 직접 호출 관계는 없지만, 위 "실서빙 게이트"(사업자·정산 승인)가 실제로 어떻게 나타나는지와 직결돼 함께 기록한다.

**조건**: iOS, `@apps-in-toss/web-framework` 2.10.0, miniAppId 31146, `PREPARE` 상태 candidate 번들을 `intoss-private` deep-link로 cold-load (환경 3), 워크스페이스 광고 사업자/정산 승인 심사중.

**측정 결과** (4건):

- `GoogleAdMob.loadAppsInTossAdMob` + 공식 테스트 ID(`ait-ad-test-interstitial-id`, `ait-ad-test-rewarded-id`) → `errorCode: PLACEMENT_ID_FETCH_FAILED`, message `GoogleAdMobLoadError(message: "Request Error: A network error occurred.", code: Optional("LOAD_FAILED"))`.
- 같은 호출을 31146 자신의 실제 지면(interstitial `ait.v2.live.f75ef8504e254b11`, rewarded `ait.v2.live.4ebc5e0284164325`)으로 → **동일한** `PLACEMENT_ID_FETCH_FAILED`. 테스트 ID 고유 현상이 아니다.
- 로드 실패 후 `showAppsInTossAdMob` 호출 → `FAILED_TO_GET_LOADED_AD`, "광고가 없습니다."
- 통합 `loadFullScreenAd` + 테스트 ID → `EXECUTION_ERROR`, "광고 요청 처리에 실패했습니다 [1011]" (서버까지 도달해 애플리케이션 레벨에서 거부된 형태 — 단순 네트워크 단절은 아님).

네 경우 모두 광고가 렌더되지 않았다.

**원인은 분리되지 않는다.** (A) 승인 게이트가 테스트 ID에도 걸리는지, (B) `PREPARE`/비-`APPROVED` 배포가 애초에 지면을 resolve하지 못하는지 — 위 관측만으로는 둘을 구분할 수 없다. 분리하려면 APPROVED 배포이거나, 승인 완료 후 재측정이 필요하다. 원인을 단정하지 않는다.

### 콘솔 쪽 대조로 좁혀진 범위 (2026-07-26 `placement-groups ls` 캡처)

위 실기기 실패를 콘솔 상태와 대조한 결과, **몇 가지 설명은 배제된다**:

- 로드를 시도한 두 지면(interstitial `ait.v2.live.f75ef8504e254b11`, rewarded `ait.v2.live.4ebc5e0284164325`)은 캡처 시점에 `state: "ENABLED"`이고, iOS·Android **양쪽**에 AdMob placement + mediation 워터폴이 채워져 있다 → **지면 부재**로는 설명되지 않는다.
- 두 지면 모두 2026-07-24 생성이다(가장 늦은 것은 rewarded, `13:08:47`). 온디바이스 측정은 "07-25/26"로만 기록돼 정확한 시각은 남아 있지 않다 — 그래도 가장 늦게 생성된 지면 기준으로 최소 약 11시간, CLI가 생성 시 안내하는 "구글 광고 시스템 반영까지 최대 2시간" 창을 크게 넘는다 → **비동기 반영 대기 중**으로도 설명되지 않는다.
- `abuse-status`가 `abuseLevel: "NONE"` / `isServingBlocked: false`이고 `blockedPlacementGroups`도 비어 있다 → **어뷰징 차단**으로도 설명되지 않는다.

**같이 적어 두는 단서**: `updTs`가 `regTs`와 같다는 사실만으로 "측정 시점에 이미 `ENABLED`였다"가 증명되지는 않는다 — 서버측 `REGISTERING`→`ENABLED` 전이가 `updTs`를 건드리지 않았을 수 있다. 위 두 번째 항목의 근거는 `updTs` 불변이 아니라 **경과 시간(최소 약 11h) 대 안내된 2시간 창**이다.

**혼동 금지**: BANNER 지면 2건은 양 플랫폼 placement가 `null`이라 애초에 미프로비저닝 상태다(위 "BANNER의 placement 비대칭"). 배너 로드가 실패한다면 그건 이미 알려진 별개 사유이므로, interstitial/rewarded 관측과 섞어 읽지 않는다.

배제된 셋을 빼고 나면 (A)/(B)는 여전히 갈리지 않고, 제3의 원인도 배제되지 않는다. 이 대조는 후보를 좁힐 뿐 원인을 특정하지 않는다.

**devtools mock은 이 실패를 예측하지 못한다**: 실패 dial(`failureModes.loadAdMob`)을 명시적으로 켜지 않는 한, mock은 `adGroupId` 값을 검사하지 않고 고정 지연 후 그냥 `loaded`를 emit한다.

## `GET .../in-app-ads-v2/abuse-status` — 어뷰징/노출차단 상태

- **Used by**: [`src/api/in-app-ads.ts#fetchAdsAbuseStatus`](../../src/api/in-app-ads.ts), `aitcc app ads abuse-status`
- **Capture status**: ✅ confirmed (2026-07-24, workspace 3095 / app 31146). 2026-07-26 재관측에서 **지면 4건이 등록된 상태로도 응답이 동일**하다 — 세 필드 값이 그대로다. 즉 아래 본문은 "지면 0건이라 비어 있는 것"이 아니라 실제 무-어뷰징 상태의 값이다.
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
- `blockedPlacementGroups`: 차단된 지면 목록. 지면 4건이 등록된 상태에서도 빈 배열이다(= "차단된 지면"만 담는 목록이지 전체 지면 목록이 아니다) — 항목 shape은 여전히 미확인. 지면 인벤토리는 위 `placement-groups`가 담당.
- 지면 entry에도 같은 이름의 `abuseLevel` 필드가 있고 4건 모두 `"NONE"`이다 — 앱 레벨 값과 지면 레벨 값이 갈라진 사례는 아직 없다.

## 짝 문서

- [`in-app-purchase.md`](./in-app-purchase.md) — 같은 앱-scope 패턴(`workspaces/<wid>/mini-app/<mini_app_id>/...`)을 쓰는 인앱결제 도메인. `products create`도 이번 `placement-groups create`와 같은 "⚠️ inferred body + `--confirm` mutation 게이트" 패턴.
- [`workspaces.md`](./workspaces.md) "promotion-money" — 워크스페이스 레벨의 자사 앱 홍보 지출 축(IAA 수익과는 다른 축이니 혼동 주의).
- [`impression.md`](./impression.md) — 미니앱 등록용 노출 카테고리(`impression.categoryIds`) 조회. 광고 지면의 `categoryId`와는 다른 taxonomy(위 "category 후보 조회" 참고).
- [`workspaces.md`](./workspaces.md) "business-verification" (`aitcc workspace business-verification show`) — 인앱광고 실서빙의 선행조건인 사업자·정산 승인 상태 확인.
