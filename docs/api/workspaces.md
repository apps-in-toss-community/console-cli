# Workspaces · Members

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces` | 사용자 워크스페이스 목록 (앱 inline 포함) | ✅ |
| GET | `/workspaces/invited` | 받은 초대 목록 | ✅ |
| GET | `/workspaces/<wid>` | 워크스페이스 상세 | ✅ |
| GET | `/workspaces/<wid>/members` | 멤버 목록 | ✅ |
| GET | `/workspaces/<wid>/members/me` | 내 멤버 정보 (per-workspace) | ⚠️ |
| GET | `/workspaces/<wid>/partner` | 파트너(빌링/정산 주체) 정보 | ⚠️ |
| GET | `/workspaces/<wid>/partner/is-registered` | 파트너 등록 여부 | ⚠️ |
| GET | `/workspaces/<wid>/business-number/verify/by-biz-reg-no?bizRegNo=` | 사업자번호 조회 | ⚠️ |
| GET | `/workspaces/<wid>/segments/list` | 세그먼트 목록 (page/category/search) | ⚠️ |
| GET | `/workspaces/<wid>/console-workspace-terms/<type>/skip-permission` | 약관 동의 필요 여부 | ⚠️ |

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

## `GET /workspaces/<wid>/members` — 멤버 목록

- **Used by**: [`src/api/members.ts#fetchWorkspaceMembers`](../../src/api/members.ts), `aitcc members`
- **Capture status**: ✅ confirmed

### Response

```json
{
  "resultType": "SUCCESS",
  "success": [
    {
      "workspaceId": 3095,
      "bizUserNo": <biz_user_no>,
      "name": "<name>",
      "email": "<email>",
      "status": "ACTIVE",
      "role": "OWNER",
      "isOwnerDelegationRequested": false,
      "isAdult": true
    }
  ]
}
```

**메모**:

- `bizUserNo`가 person-stable identifier. 같은 사람이 여러 워크스페이스에 속해 있어도 동일.
- `status`: 관측값 `"ACTIVE"`. `"INVITED"`, `"REMOVED"` 등 추가 enum은 미관측.
- `role`: `"OWNER"`, `"MEMBER"` 등.

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

## 미캡처 endpoint

- `GET /workspaces/<wid>/partner`, `/partner/is-registered`: 파트너 등록 흐름. CLI 미사용. 코드의 `fetchWorkspacePartner`는 inferred shape.
- `GET /workspaces/<wid>/business-number/verify/by-biz-reg-no?bizRegNo=`: 사업자번호 조회. 콘솔 등록 마법사에서 호출됨.
- `POST /workspaces`, `PATCH /workspaces/<wid>/edit`: 워크스페이스 생성/수정. CLI scope 밖.
- `POST /workspaces/<wid>/owner-delegations`, `/owner-delegations/complete`: 소유권 위임. CLI scope 밖.
- `POST /workspaces/<wid>/console-workspace-terms`, `/re-agree`: 약관 동의. CLI scope 밖.
- `POST /workspaces/<wid>/invites`, `/invites/send/by-email`, `/invites/accept`, `/invites/reject`, `DELETE /workspaces/<wid>/invites`: 초대 관리. CLI scope 밖.
