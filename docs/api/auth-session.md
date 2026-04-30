# Auth · Session

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/members/me/user-info` | 현재 사용자 정보 + 소속 워크스페이스 목록 | ✅ |
| GET | `/console-user-terms/me` | 사용자 본인의 콘솔 이용약관 동의 상태 | ✅ |

## 인증 흐름 (참고)

콘솔은 OAuth로 로그인한 후 `apps-in-toss.toss.im` 도메인에 HttpOnly 세션 쿠키를 발급한다. CLI는:

1. CDP로 시스템 Chrome을 ephemeral profile로 spawn → 사용자가 직접 OAuth 완료.
2. main frame URL이 `apps-in-toss.toss.im/workspace[/*]`에 도달하면 `Network.getAllCookies`로 모든 쿠키(HttpOnly 포함) dump.
3. 이후 `fetch()` 요청에 `Cookie:` 헤더를 직렬화해 첨부. 별도 bearer 없음.

자세한 결정 근거는 console-cli `CLAUDE.md` "Login 선택 근거" 참고.

## `GET /members/me/user-info` — 현재 사용자 정보

CLI 로그인 직후의 liveness check. 모든 명령이 부팅 시점에 한 번씩 호출.

- **Used by**: [`src/api/me.ts#fetchConsoleMemberUserInfo`](../../src/api/me.ts), [`src/commands/whoami.ts`](../../src/commands/whoami.ts), [`src/commands/login.ts`](../../src/commands/login.ts)
- **Capture status**: ✅ confirmed
- **Auth**: 세션 쿠키
- **Query**: 없음
- **Request body**: 없음

### Response

```jsonc
{
  "resultType": "SUCCESS",
  "success": {
    "id": <user_id>,
    "bizUserNo": <biz_user_no>,
    "name": "<name>",
    "email": "<email>",
    "role": "MEMBER",
    "channelIoHash": "<channel_io_hash>",
    "workspaces": [
      {
        "workspaceId": 3095,
        "workspaceName": "<workspace_name>",
        "role": "OWNER",
        "isOwnerDelegationRequested": false
      },
      {
        "workspaceId": 36577,
        "workspaceName": "<workspace_name>",
        "role": "OWNER",
        "isOwnerDelegationRequested": false
      }
    ],
    "isAdult": true,
    "isOverseasBusiness": false,
    "minorConsents": []
  }
}
```

**메모**:

- `role` (top-level): 콘솔 user 등급. `"MEMBER"` 외 다른 값은 미관측.
- `workspaces[].role`: per-workspace 권한. `"OWNER"`, `"MEMBER"` 등.
- `workspaces[]`는 단순 명단. 각 워크스페이스 상세는 `/workspaces/<wid>` 별도 호출.
- 사용자 식별자 (`id`, `bizUserNo`, `name`, `email`, `channelIoHash`)는 redaction 대상. 값 그대로는 절대 체크인 금지.

## `GET /console-user-terms/me` — 사용자 콘솔 이용약관 동의 상태

- **Used by**: [`src/api/me.ts#fetchUserTerms`](../../src/api/me.ts), `aitcc me terms`
- **Capture status**: ✅ confirmed
- **Auth**: 세션 쿠키

### Response

```json
{
  "resultType": "SUCCESS",
  "success": [
    {
      "required": true,
      "termsId": 11157,
      "revisionId": 55459,
      "title": "앱인토스 콘솔 이용약관",
      "contentsUrl": "https://...",
      "actionType": "NONE",
      "isAgreed": true,
      "isOneTimeConsent": false
    }
  ]
}
```

**메모**:

- 워크스페이스-level 약관(`/workspaces/<wid>/console-workspace-terms/...`)과 별도. 이건 사용자 본인의 콘솔 가입 약관.
- shape이 [`workspaces.md`](./workspaces.md)의 워크스페이스 약관과 동일 — 둘 다 같은 `terms` 모델 위에 얹혀 있다.
