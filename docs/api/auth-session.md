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

## CLI surface (consolidated 0.1.x)

`aitcc login` / `aitcc logout` / `aitcc whoami`가 단일 진입점이다. 흩어져 있던
`aitcc auth set` / `auth clear` / `auth status`는 deprecation shim으로 한동안 유지되며
1.0에서 제거된다.

**Credential resolution 우선순위 (`aitcc login`)**:

1. `--email` + `--password-stdin` (또는 `--password` plain — `ps`/Task Manager 노출 경고).
2. `AITCC_EMAIL` + `AITCC_PASSWORD` env.
3. OS keychain (이전 `--save keychain` 또는 인터랙티브 prompt에서 저장한 값).
4. TTY interactive prompt — email / password / 저장 위치(`keychain` | `none`)를 한 번에 묻는다.
5. Non-TTY + 자격 정보 없음 → exit 2 (`interactive-required`)로 명시적 거부.

`--save keychain`은 로그인을 시도하기 전에 먼저 keychain write를 시도한다. backend가 없거나
실패하면 fatal (exit 2 `keychain-save-failed`) — partial state를 만들지 않는다.
`--interactive`는 자격 정보가 있어도 visible 브라우저 흐름을 강제한다 (계정 전환·step-up용).
이때 `--email/--password*/--save`와 함께 쓰면 사용자가 입력한 자격이 form-fill에 쓰이지 않고
조용히 버려지므로, 조합을 일찍 거부한다 (exit 2 `conflicting-interactive-flags`).

**예시 시나리오**:

- 첫 사용 (desktop, TTY): `aitcc login` → 이메일·비밀번호 입력 → "OS keychain (recommended)" 선택
  → 다음부터 `aitcc login`은 prompt 없이 headless 진행.
- CI single-shot: `printf '%s' "$PW" | aitcc login --email you@x --password-stdin --json`
  (stdin이 TTY가 아니어야 안전, 비밀번호는 argv에 노출되지 않음).

**JSON 계약**:

- `aitcc whoami --json`: `{ ok, authenticated, credentialSource: 'env'|'keychain'|'none', credentialEmail?, … }`.
  agent-plugin이 `credentialSource === 'none'`이면 `aitcc login` 안내를 띄운다.
- `aitcc logout --json`: `{ ok, sessionRemoved, credentialsPurged, path, purgeError? }`.
  `--purge`로 keychain credential까지 같이 지운다.
- `aitcc login --json`: `credentialSource: 'argv'|'env'|'keychain'|'prompt'|'browser'`,
  `saved: 'created'|'updated'|'unchanged'|'skipped'` 필드로 어떤 경로로 들어갔고 무엇을 저장했는지 보고한다.

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
