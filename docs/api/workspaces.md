# Workspaces

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

> 멤버 조회·초대·제거 endpoint는 [`members.md`](./members.md)로 분리됨 (2026-05-08).

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces` | 사용자 워크스페이스 목록 (앱 inline 포함) | ✅ |
| GET | `/workspaces/invited` | 받은 초대 목록 | ✅ |
| GET | `/workspaces/<wid>` | 워크스페이스 상세 | ✅ |
| GET | `/workspaces/<wid>/partner` | 파트너(빌링/정산 주체) 정보 | ⚠️ |
| GET | `/workspaces/<wid>/partner/is-registered` | 파트너 등록 여부 | ⚠️ |
| GET | `/workspaces/<wid>/business-number/verify/by-biz-reg-no?bizRegNo=` | 사업자번호 조회 | ⚠️ |
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

- `GET /workspaces/<wid>/partner`, `/partner/is-registered`: 파트너 등록 흐름. CLI 미사용. 코드의 `fetchWorkspacePartner`는 inferred shape.
- `GET /workspaces/<wid>/business-number/verify/by-biz-reg-no?bizRegNo=`: 사업자번호 조회. 콘솔 등록 마법사에서 호출됨.
- `POST /workspaces`, `PATCH /workspaces/<wid>/edit`: 워크스페이스 생성/수정. CLI scope 밖.
- `POST /workspaces/<wid>/owner-delegations`, `/owner-delegations/complete`: 소유권 위임. CLI scope 밖.
- `POST /workspaces/<wid>/console-workspace-terms/re-agree`: 약관 개정 시 동의 갱신. CLI 미사용 (정규 동의는 `POST .../console-workspace-terms` 항목 참조).
- 초대 관리(`POST /invites/...`, `DELETE /invites`)와 멤버 제거(`DELETE /members/<biz_user_no>`)는 [`members.md`](./members.md)로 분리.
