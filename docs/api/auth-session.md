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

## Cookie portability (실측)

세션 쿠키는 **country-bound (KR allowlist)**. 같은 cookie blob이라도:
- 한국 residential IP: cross-machine, cross-network OK (200)
- 한국 외 IP (예: GHA Azure US/EU): 401 / `errorCode: 4010`

UA / Origin / Referer / TLS fingerprint는 enforce 안 됨 — 차단은
순수 IP-based. Cookie는 거부당해도 invalidate되지 않음 (KR로
돌아오면 다시 200).

인증에 충분한 쿠키는 **`TBIZAUTH` 한 개**. 나머지는 analytics/
hotjar/channel.io noise.

실측 데이터는 spike 보고서 (2026-05-08 spike-ci-cookie) 기준
— 정책 변경 시 재검증 필요.

## Export/import for CI

`aitcc auth export` / `auth import`은 desktop에서 잡은 세션을 CI 시크릿으로
옮기기 위한 짝 명령이다.

- `aitcc auth export --format env`은 stdout에 정확히 한 줄
  `AITCC_SESSION=<base64>`을 emit. base64 페이로드는 `session.json`을
  그대로 인코딩한 것이라 stdout/SHA가 그대로 secret manager / `>> $GITHUB_ENV`로
  들어간다. 디버그용 `--format json`은 raw shape를 pretty-print해서 사람이
  열어 볼 수 있게 한다.
- `aitcc auth import --from-env` (env에서 읽기) 또는 `aitcc auth import < blob.json`
  (stdin)으로 다시 file 형식으로 복원. base64 / raw JSON 자동 감지. 스키마
  검증을 거치고 v1 blob은 v2로 마이그레이트한다. `--dry-run`은 검증만.
- `AITCC_SESSION` env가 set이면 모든 명령은 file 대신 env에서 세션을
  읽는다. 같은 모드에서 `writeSession` / `clearSession`은 의도적으로
  no-op (`logout`, `workspace use` 등이 CI 호스트에 0600 파일을 남기지
  않게).

**KR-only 제약**은 export/import 자체가 풀어주지 못한다. 같은 blob을
GHA-hosted runner (Azure US/EU)에 박으면 첫 호출부터 401/`errorCode: 4010`.
KR self-hosted runner / 한국 VPS / 사용자 로컬에서만 동작. README와 모든
명령 surface (`--help`, stderr warning, `--json` envelope의
`warning: 'kr-only-cookies'` 필드)에서 같은 문구로 경고한다.

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
        "workspaceId": <workspace_id>,
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
