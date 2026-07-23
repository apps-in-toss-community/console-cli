# Workspaces

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

> 멤버 조회·초대·제거 endpoint는 [`members.md`](./members.md)로 분리됨 (2026-05-08).

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces` | 사용자 워크스페이스 목록 (앱 inline 포함) | ✅ |
| GET | `/workspaces/invited` | 받은 초대 목록 | ✅ |
| GET | `/workspaces/<wid>` | 워크스페이스 상세 | ✅ |
| GET | `/workspaces/<wid>/partner` | 파트너(빌링/정산 주체) 정보 | ✅ |
| GET | `/workspaces/<wid>/partner/is-registered` | 파트너 등록 여부 | ✅ |
| GET | `/workspaces/<wid>/business-number/verify/by-biz-reg-no?bizRegNo=` | 사업자번호 조회 | ⚠️ |
| GET | `/workspaces/<wid>/business-verification/license/data` | 사업자 라이선스 인증 상태 | ✅ |
| GET | `/workspaces/<wid>/configs` | 토스페이 키 설정 상태 (마스킹) | ✅ |
| GET | `/workspaces/<wid>/promotion-money` | 프로모션 머니 잔액 | ✅ |
| GET | `/workspaces/<wid>/promotion-money/histories` | 프로모션 머니 사용 내역 | ⚠️ mixed (빈 목록 ✅, 항목 shape 미관측) |
| GET | `/workspaces/<wid>/segments/list` | 세그먼트 목록 (page/category/search) | ⚠️ |
| GET | `/workspaces/<wid>/console-workspace-terms/<type>/skip-permission` | 약관 동의 필요 여부 | ⚠️ |
| POST | `/workspaces/<wid>/console-workspace-terms` | 약관 동의 제출 (`agreedList`) | ✅ |

> **Note**: console-cli는 사용자 워크스페이스 목록을 별도로 가져오지 않는다. `GET /members/me/user-info`의 `workspaces[]`를 그대로 사용한다 ([`auth-session.md`](./auth-session.md) 참고). 아래 `GET /workspaces`는 콘솔 SPA의 동작 캡처이며 CLI 코드 경로엔 없음.

## `GET /workspaces` — 사용자 워크스페이스 목록 (앱 inline 포함)

- **Used by**: 콘솔 SPA. CLI에서는 `/members/me/user-info`로 대체.
- **Capture status**: ✅ confirmed
- **Auth**: 세션 쿠키

### Response

각 워크스페이스 객체에 `miniApps[]`이 inline으로 들어 있어 응답이 큼. 실제 shape은 [`mini-apps.md`](./mini-apps.md)의 `GET /workspaces/<wid>/mini-app` 단일 항목과 동일한 구조가 array로 들어간다. CLI는 이 endpoint에 의존하지 않으므로 본문 본 캡처는 stash만.

## `GET /workspaces/invited` — 받은 초대 목록

- **Used by**: 콘솔 SPA의 초대 알림 배지.
- **Capture status**: ✅ confirmed (빈 array)

```json
{ "resultType": "SUCCESS", "success": [] }
```

## `GET /workspaces/<wid>` — 워크스페이스 상세

- **Used by**: [`src/api/workspaces.ts#fetchWorkspaceDetail`](../../src/api/workspaces.ts)
- **Capture status**: ✅ confirmed
- **Drift**: list endpoint(`workspaces[]`)는 `workspaceId`/`workspaceName`을 쓰지만 detail은 `id`/`name`을 쓴다. CLI 측에서 normalize함 (`{workspaceId, workspaceName, extra}`).

### Response (정규화 전)

```jsonc
{
  "resultType": "SUCCESS",
  "success": {
    "id": 3095,
    "name": "<workspace_name>",
    // ... 비즈니스 등록 / 검증 / 라이선스 / review state 등 다수 필드
    // CLI에서는 `id`/`name`만 정규화하고 나머지는 `extra`로 통째로 보존
  }
}
```

## `GET /workspaces/<wid>/partner/is-registered` — 파트너 등록 여부

- **Used by**: [`src/api/workspaces.ts#fetchWorkspacePartnerIsRegistered`](../../src/api/workspaces.ts), `aitcc workspace partner`
- **Capture status**: ✅ confirmed (2026-07-23, workspace 3095, 미등록 상태)
- **Auth**: 세션 쿠키
- `/partner`보다 가벼운 전용 상태 체크 endpoint. 같은 `registered`/`approvalType`/`rejectMessage` 트리오를 반환하지만 `partner` 상세 블록은 없다.

### Response

```json
{
  "resultType": "SUCCESS",
  "success": { "registered": false, "approvalType": "DRAFT", "rejectMessage": null }
}
```

## `GET /workspaces/<wid>/partner` — 파트너(빌링/정산 주체) 정보

- **Used by**: [`src/api/workspaces.ts#fetchWorkspacePartner`](../../src/api/workspaces.ts), `aitcc workspace partner`
- **Capture status**: ✅ confirmed (2026-07-23, workspace 3095, 미등록 상태)
- **Auth**: 세션 쿠키
- `registered: false`일 때 `partner`는 `null`. 승인된 이후의 `partner` 상세 블록 shape은 아직 미관측.

### Response

```json
{
  "resultType": "SUCCESS",
  "success": {
    "registered": false,
    "approvalType": "DRAFT",
    "rejectMessage": null,
    "partner": null
  }
}
```

### `aitcc workspace partner`의 병합

`aitcc workspace partner`는 이 두 endpoint(`/partner`, `/partner/is-registered`)를 병렬로 호출해 하나의 상태 뷰로 합친다(`src/commands/workspace.ts#mergePartnerStates`). 지금까지의 유일한 라이브 관측(workspace 3095, 미등록 상태)에서는 두 endpoint가 정확히 일치했다 — 서로 다른 값을 반환하는 사례는 아직 없다. 병합 규칙: `registered`는 둘 중 하나라도 `true`면 `true`(이미 등록된 상태를 숨기지 않는 쪽으로 fail), `approvalType`/`rejectMessage`는 `/partner` 값을 우선하고 `null`일 때만 `/partner/is-registered` 값으로 fallback.

### `GET /workspaces/<wid>/partner/review` — 미등록 상태에서 500

- **Capture status**: ⚠️ inferred (path만 정적 분석으로 확인, 응답은 관측했으나 shape 미확정)
- **관측** (2026-07-23, workspace 3095, 미등록 상태): `resultType: FAIL, errorCode: "500"`. 미등록 워크스페이스에서 review 상세를 조회하려는 시도 자체가 서버 오류로 이어지는 것으로 보인다 — 파트너 등록 후 재관측 필요.
- CLI는 이 endpoint를 아직 사용하지 않는다 (`aitcc workspace partner`는 `/partner` + `/partner/is-registered`만 호출).

## `GET /workspaces/<wid>/business-verification/license/data` — 사업자 라이선스 인증 상태

- **Used by**: [`src/api/business-verification.ts#fetchBusinessVerificationLicense`](../../src/api/business-verification.ts), `aitcc workspace business-verification show`
- **Capture status**: ✅ confirmed (2026-07-24, workspace 3095, 미등록 상태)
- **Auth**: 세션 쿠키

### Response (관측 — 미등록 상태)

```json
{
  "resultType": "SUCCESS",
  "success": { "errorCode": 500 }
}
```

**중요**: 이건 HTTP 레벨 실패가 아니다 — envelope의 `resultType`은 여전히 `SUCCESS`고, `success` payload **안에** 비즈니스 레벨 `errorCode: 500`이 들어 있는 형태다. `TossApiError`는 `resultType: FAIL`에서만 던져지므로(`src/api/http.ts`), 이 응답은 정상적으로 unwrap되어 호출자에게 `{errorCode: 500}` 객체로 전달된다. `errorCode`가 없으면(= 라이선스 인증 완료) `registered: true`로, 있으면 `registered: false`로 CLI가 normalize한다. 이 500은 [`_error-codes.md`](./_error-codes.md)의 전송-레벨 `500`(FAIL envelope으로 오는 권한 부족)과 **다른 코드 계열**이니 혼동하지 말 것 — 같은 숫자값이지만 도착 경로가 다르다.

`aitcc workspace business-verification show`는 이 상태를 `GET /partner/is-registered`(위 참조)와 함께 병렬 조회해 하나의 리포트로 합친다 — 사업자 라이선스와 파트너(빌링/정산) 등록은 서로 다른 게이트이지만 워크스페이스가 수익화 기능을 켜기 전에 둘 다 확인해야 하는 축이라 함께 보여준다.

## `GET /workspaces/<wid>/configs` — 토스페이 키 설정 상태

- **Used by**: [`src/api/pay-config.ts#fetchPayConfigStatus`](../../src/api/pay-config.ts), `aitcc app pay-config show`
- **Capture status**: ✅ confirmed (2026-07-24, workspace 3095) — 모든 필드 미설정(`null`/빈 문자열) 상태
- **Auth**: 세션 쿠키

### Response (관측 — 전부 미설정)

```jsonc
{
  "resultType": "SUCCESS",
  "success": {
    "workspaceId": 3095,
    "payApiKey": null,
    "testPayApiKey": null,
    "billingPayApiKey": null,
    "testBillingPayApiKey": null,
    "tossCertClientId": null
    // 값이 설정되면 문자열이 온다고 추정 — 실제 SET 상태의 라이브 캡처는 아직 없음
  }
}
```

### ★ 값 마스킹 관례 (SECRET-HANDLING) ★

이 다섯 필드는 인앱결제/정산에 쓰이는 자격증명이라 [`_redaction.md`](./_redaction.md) + Deploy Key(`api-keys.md` "보안 노트")와 동일한 취급 원칙을 따른다 — **평문 값은 어떤 출력 경로(사람이 읽는 텍스트, `--json`, 로그, 에러 메시지)에도 노출하지 않는다.** `api-keys.md`의 Deploy Key와 달리 "발급 직후 1회 노출" 같은 예외 창구도 없다 — 이건 기왕에 설정돼 있는 워크스페이스 구성값이라 CLI가 값을 보여줘야 할 정당한 시점 자체가 없다.

masking은 API 레이어(`fetchPayConfigStatus`)에서 응답을 받자마자 수행된다 — 커맨드 레이어에 원시 값이 아예 도달하지 않는다. 노출되는 건 `'SET' | 'UNSET'` 두 값뿐:

```jsonc
{
  "ok": true,
  "workspaceId": 3095,
  "payApiKey": "UNSET",
  "testPayApiKey": "UNSET",
  "billingPayApiKey": "UNSET",
  "testBillingPayApiKey": "UNSET",
  "tossCertClientId": "UNSET"
}
```

## `GET /workspaces/<wid>/promotion-money` — 프로모션 머니 잔액

- **Used by**: [`src/api/promotion-money.ts#fetchPromotionMoneyBalance`](../../src/api/promotion-money.ts), `aitcc workspace promotion-money show`
- **Capture status**: ✅ confirmed (2026-07-24, workspace 3095) — 캠페인 미집행 상태라 양쪽 다 0
- **Auth**: 세션 쿠키
- **개념 축**: "프로모션 머니"는 워크스페이스가 **자사 앱을 홍보하려고 지출**하는 예산이다. [`in-app-ads.md`](./in-app-ads.md)의 IAA(인앱 광고 노출로 **벌어들이는** 수익)와는 정반대 축이니 혼동하지 말 것 — CLI 명령 설명(`aitcc workspace promotion-money show --help`)에도 이 구분을 명시해 뒀다.

### Response (관측)

```json
{ "resultType": "SUCCESS", "success": { "balance": 0, "availableBalance": 0 } }
```

`balance`/`availableBalance` 외 서버가 더 보내는 필드가 있으면 `extra`로 보존한다.

## `GET /workspaces/<wid>/promotion-money/histories` — 프로모션 머니 사용 내역

- **Used by**: [`src/api/promotion-money.ts#fetchPromotionMoneyHistories`](../../src/api/promotion-money.ts), `aitcc workspace promotion-money show`
- **Capture status**: ⚠️ mixed — 빈 목록 응답은 ✅ confirmed(2026-07-24, workspace 3095), 항목이 있을 때의 wrapper shape(bare array vs `{contents, totalPage, currentPage}` page-object)과 개별 entry 필드는 미관측
- **Query**: `?page=<int>` (다른 목록 endpoint와 동일 관례로 추정)

### Response (관측 — 빈 목록)

```json
{ "resultType": "SUCCESS", "success": [] }
```

CLI(`normalizeHistoryResponse`)는 이 endpoint가 이 API 계열의 다른 목록들처럼 page-object로 바뀌어도, 지금처럼 bare array로 남아도 둘 다 받아들이도록 방어적으로 파싱한다 — 실제 항목이 들어오는 첫 라이브 캡처에서 이 문서와 파서를 확정 shape으로 갱신할 것.

## `GET /workspaces/<wid>/segments/list` — 세그먼트 목록

- **Used by**: [`src/api/workspaces.ts#fetchWorkspaceSegments`](../../src/api/workspaces.ts), `aitcc workspace segments ls`
- **Capture status**: ⚠️ inferred (빈 워크스페이스에서만 확인)
- **Query**: `?category=<string>&search=<string>&page=<int>` — 모두 필수처럼 동작 (UI가 항상 보냄)
- **Default category**: `"생성된 세그먼트"` (UI 기본 탭)
- **Response**: page-based `{contents: [], totalPage, currentPage}`

```json
{
  "resultType": "SUCCESS",
  "success": { "contents": [], "totalPage": 0, "currentPage": 0 }
}
```

## `GET /workspaces/<wid>/console-workspace-terms/<type>/skip-permission` — 약관 필요 여부

- **Used by**: [`src/api/workspaces.ts#fetchWorkspaceTerms`](../../src/api/workspaces.ts), `aitcc workspace terms`
- **Capture status**: ⚠️ inferred (코드 + 콘솔 정적 분석)
- **`<type>` 허용값** (콘솔 UI 기준):
  - `TOSS_LOGIN` — 토스 로그인 scope
  - `BIZ_WORKSPACE` — 비즈 워크스페이스 자격
  - `TOSS_PROMOTION_MONEY` — 프로모션 머니
  - `IAA` — In-App Advertising
  - `IAP` — In-App Purchase
- 다른 값은 현재 404.

### Response

```json
{
  "resultType": "SUCCESS",
  "success": [
    {
      "required": true,
      "termsId": 0,
      "revisionId": 0,
      "title": "...",
      "contentsUrl": "...",
      "actionType": "...",
      "isAgreed": false,
      "isOneTimeConsent": false
    }
  ]
}
```

shape은 [`auth-session.md`](./auth-session.md)의 `/console-user-terms/me`와 동일.

## `POST /workspaces/<wid>/console-workspace-terms` — 약관 동의 제출

- **Used by**: [`src/api/workspaces.ts#agreeWorkspaceTerms`](../../src/api/workspaces.ts), `aitcc workspace terms agree`
- **Capture status**: ✅ confirmed (2026-05-08, ws=36577, BIZ_WORKSPACE 3건 동의)
- **Request body**: `{"agreedList": [{"termsId": <int>, "revisionId": <int>}, ...]}`
- 단일 endpoint로 여러 type을 한 번에 받는다 — type tag는 implicit이고 (`termsId`, `revisionId`) 페어로만 식별. 클라이언트가 `<type>/skip-permission` 응답에서 받은 그 페어를 그대로 echo back하면 됨.

### Response

```json
{ "resultType": "SUCCESS", "success": {} }
```

`success`는 빈 객체. 의미 있는 payload는 없음.

### 비-idempotent 동작

이미 동의된 `(termsId, revisionId)`를 다시 보내면 `errorCode: "500"` (Internal Server Error)이 떨어진다. 클라이언트는 `<type>/skip-permission`을 먼저 호출해서 `isAgreed === false`인 항목만 추려서 제출해야 한다. CLI 측은 `agreeWorkspaceTerms`를 호출하기 전에 항상 fetch → filter pending → submit 순서를 강제한다.

빈 `agreedList`를 보내면 SUCCESS가 떨어지지만(no-op), 이쪽도 클라이언트가 round-trip 전에 가드한다 (`agreeWorkspaceTerms` requires at least one term).

### 짝 endpoint (미캡처)

- `POST /workspaces/<wid>/console-workspace-terms/re-agree`: 콘솔이 약관 개정 시 호출하는 동의 갱신. CLI는 미사용.

## 미캡처 endpoint

- `GET /workspaces/<wid>/business-number/verify/by-biz-reg-no?bizRegNo=`: 사업자번호 조회. 콘솔 등록 마법사에서 호출됨.
- `POST /workspaces`, `PATCH /workspaces/<wid>/edit`: 워크스페이스 생성/수정. CLI scope 밖.
- `POST /workspaces/<wid>/owner-delegations`, `/owner-delegations/complete`: 소유권 위임. CLI scope 밖.
- `POST /workspaces/<wid>/console-workspace-terms/re-agree`: 약관 개정 시 동의 갱신. CLI 미사용 (정규 동의는 `POST .../console-workspace-terms` 항목 참조).
- 초대 관리(`POST /invites/...`, `DELETE /invites`)와 멤버 제거(`DELETE /members/<biz_user_no>`)는 [`members.md`](./members.md)로 분리.
