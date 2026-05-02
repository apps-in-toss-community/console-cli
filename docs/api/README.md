# Apps in Toss console — API inventory

`console-cli`(`aitcc`)가 호출하는 모든 콘솔 API의 **확정된 shape + 캡처된 샘플 데이터**를 도메인별로 정리한 문서다.

코드(`src/api/*.ts`, `src/commands/*.ts`)의 짝 문서. 콘솔 UI 변경으로 인한 drift를 추적하고, 새 명령을 추가할 때 추측 없이 첫 시도를 정확히 만드는 것이 목표.

> ⚠️ **공식 API가 아니다.** 토스가 공개·문서화한 API가 아니라, 공개 개발자 콘솔 SPA(`apps-in-toss.toss.im/console`)가 사용자 인증 세션 안에서 호출하는 내부 endpoint들의 **관찰된 동작**이다. 콘솔 UI 변경 시 깨질 수 있다. 자세히는 `console-cli` repo 루트 `CLAUDE.md` 참고.

## 색인

도메인별 캡처 상태:

| 도메인 | 파일 | 상태 |
|---|---|---|
| 공통 규약 | [`_conventions.md`](./_conventions.md) | — |
| Error code 카탈로그 | [`_error-codes.md`](./_error-codes.md) | — |
| Redaction 정책 | [`_redaction.md`](./_redaction.md) | — |
| Auth · Session | [`auth-session.md`](./auth-session.md) | ✅ confirmed |
| Workspaces · Members | [`workspaces.md`](./workspaces.md) | ✅ confirmed |
| Mini-apps (등록·조회) | [`mini-apps.md`](./mini-apps.md) | ✅ confirmed |
| Mini-apps · 이미지 업로드 | [`mini-app-images.md`](./mini-app-images.md) | ✅ confirmed |
| Mini-apps · Bundles · Deployments | [`mini-app-bundles.md`](./mini-app-bundles.md) | ⚠️ inferred (코드 + 정적 분석) |
| Mini-apps · 기타 (certs/params/analytics/logs) | [`mini-app-misc.md`](./mini-app-misc.md) | ⚠️ inferred (정적 분석) |
| API Keys | [`api-keys.md`](./api-keys.md) | ✅ confirmed |
| Impression (카테고리) | [`impression.md`](./impression.md) | ✅ confirmed |
| Notices (별도 호스트) | [`notices.md`](./notices.md) | ⚠️ inferred |

**상태 의미**:

- ✅ **confirmed**: 실제 캡처된 request/response가 인라인 본문에 포함됨. dog-food 또는 manual capture로 검증됨.
- ⚠️ **inferred**: 코드(`src/api/*.ts`)와 콘솔 번들 정적 분석(`bootstrap.*.js` grep)으로 path/method는 알지만 본문은 미캡처. 호출 시 실제 shape으로 보강 필요.
- ❌ **not captured**: path만 알고 그 외 정보 없음.
- 🚫 **user-inaccessible**: route는 실재(OPTIONS preflight으로 확인)하지만 일반 사용자 OWNER 세션엔 막혀 있음. 운영팀 admin 권한 전용으로 추정.

## 캡처 방법

1. Chrome을 Playwright MCP로 띄워 콘솔에 maintainer가 직접 로그인 (cookie 기반 세션, 프로그램 인증 없음).
2. 각 콘솔 페이지(워크스페이스 → 앱 목록 → 등록 마법사 → 검토 제출 등)를 수동으로 driving하면서 `network_requests` + `evaluate(fetch(url, {credentials: 'include'}))`로 응답 본문까지 캡처.
3. 모든 캡처는 redact ([`_redaction.md`](./_redaction.md) 정책)를 적용한 뒤 이 문서의 endpoint 항목 안에 인라인 JSON으로 박아넣음.
4. **체크인 안 함**: raw 캡처 파일은 umbrella `.playwright-mcp/xhr-captures/`(gitignored)에만 보관. 외부 contributor에겐 이 디렉토리만 보인다.
5. 코드(`src/api/*.ts`)와 어긋나면 endpoint의 "Drift" 항목에 기록.

## 갱신 규칙

- **콘솔 UI에 visible change가 보이면**: 코드 패치 전에 먼저 재캡처. diff가 곧 patch 설명.
- **새 명령 추가 시**: 첫 호출 시도 전에 이 문서를 본다. 코드와 어긋나면 코드를 고친다.
- **`CLAUDE.md`의 "API quirks"는 요약**: 결정의 근거 (왜 이렇게 짰는지)와 회귀 사례만 둔다. 실제 shape의 source of truth는 이 문서.
- **민감 데이터 금지**: 캡처된 cookie, bearer token, session id, 사용자 식별자(이메일/이름/userId/bizUserNo/channelIoHash)는 [`_redaction.md`](./_redaction.md)에 따라 placeholder로 치환한 뒤 체크인.

## 짝 코드

| 도메인 | 코드 |
|---|---|
| Auth · Session | [`src/api/me.ts`](../../src/api/me.ts), [`src/commands/whoami.ts`](../../src/commands/whoami.ts) |
| Workspaces · Members | [`src/api/workspaces.ts`](../../src/api/workspaces.ts), [`src/api/members.ts`](../../src/api/members.ts) |
| Mini-apps | [`src/api/mini-apps.ts`](../../src/api/mini-apps.ts), [`src/commands/register.ts`](../../src/commands/register.ts), [`src/commands/register-payload.ts`](../../src/commands/register-payload.ts) |
| API Keys | [`src/api/api-keys.ts`](../../src/api/api-keys.ts), [`src/commands/keys.ts`](../../src/commands/keys.ts) |
| Notices | [`src/api/ipd-thor.ts`](../../src/api/ipd-thor.ts), [`src/commands/notices.ts`](../../src/commands/notices.ts) |

## 다음 캡처 작업

각 도메인 파일에 흩어져 있는 ⚠️/❌ 항목을 한자리에 모은 우선순위 목록. 새로 캡처가 들어오면 해당 endpoint 항목을 ✅로 승격하고 본 표에서 줄을 지운다.

**우선순위 1 — 빈 워크스페이스에서도 가능 (가장 빨리 해소 가능)**:

- `GET /workspaces/<wid>/members/me` — workspace landing 시 자동 호출, `.playwright-mcp/xhr-captures/`에 raw 있을 가능성. ([`workspaces.md`](./workspaces.md))
- `GET /workspaces/<wid>/partner/is-registered` — 동일. ([`workspaces.md`](./workspaces.md))
- `GET /workspaces/<wid>/console-workspace-terms/<type>/skip-permission` — 등록 마법사 진입 시 호출. ([`workspaces.md`](./workspaces.md))
- `GET /workspaces/129/posts`, `/categories` (notices) — 사이드바 자동 호출. ([`notices.md`](./notices.md))
- `GET /workspaces/129/posts/<post_id>` — 공지 상세 1개 클릭. ([`notices.md`](./notices.md))

**우선순위 2 — sdk-example dog-food 진행 시 자연스럽게 캡처**:

- `POST /workspaces/<wid>/mini-app/pre-review` — AI 사전 검토 버튼. ([`mini-apps.md`](./mini-apps.md))
- `mini-app-bundles.md` 전체 — `app deploy` 흐름 (initialize → upload → complete → review → release) E2E. ([`mini-app-bundles.md`](./mini-app-bundles.md))
- `app reports` cursor pagination shape — 한 번이라도 신고 들어오면 캡처. ([`mini-app-misc.md`](./mini-app-misc.md))

**우선순위 3 — 운영 데이터 누적 후**:

- `app metrics` heartbeat/retention 실제 응답 (현재는 빈 배열 + `cacheTime`). ([`mini-app-misc.md`](./mini-app-misc.md))
- `app events` log catalog 한 항목의 실 본문 (현재는 빈 배열). ([`mini-app-misc.md`](./mini-app-misc.md))
- API key 발급된 후 list 응답 — fallback chain 정리. ([`api-keys.md`](./api-keys.md))
- Certs 발급된 후 list 응답. ([`mini-app-misc.md`](./mini-app-misc.md))

**우선순위 4 — 별도 액션 필요**:

- `POST /workspaces/<wid>/api-keys` (발급) — 1회성 액션, dog-food 시 별도 진행. ([`api-keys.md`](./api-keys.md))
- `PUT /workspaces/<wid>/api-keys/<id>/disable` — 발급 후 검증 페어로 동시 캡처. ([`api-keys.md`](./api-keys.md))
- toss-login `review` / `marketing-agreement` / `encryption-key/email` — 토스 로그인 사용 사례 필요. ([`mini-app-misc.md`](./mini-app-misc.md))
- `smart-message` / `segments` / `templates` / `maintenance-jobs` 도메인 sub-path — `bootstrap.*.js` grep으로 path 추출 후 캡처. ([`mini-app-misc.md`](./mini-app-misc.md))

## 확인된 endpoint 부재 (anti-inventory)

콘솔 번들 정적 분석으로 **존재하지 않음이 확인된** endpoint들. "찾아볼 필요 없음"을 확정해 두는 항목으로, 새 명령을 짤 때 같은 길을 또 헤매지 않도록 둔다.

| 부재한 endpoint | 영향 | 출처 |
|---|---|---|
| `POST /mini-app/<id>/review-withdraw` (또는 동치) | `approvalType: REVIEW` 잠금을 사용자가 직접 풀 방법 없음. 운영팀 검수 결과(APPROVED/REJECTED) 대기 외 우회 없음. `bundles/reviews/withdrawal`, `templates/.../review/withdraw`, `smart-message/.../review-withdraw`는 다른 도메인엔 존재하지만 mini-app 도메인엔 없음. | [`mini-apps.md`](./mini-apps.md) "Update mode" |
| `DELETE /mini-app/<id>` (정상 동작) | OPTIONS preflight은 통과하지만 실제 DELETE는 HTTP 500. 폐기 처리는 검수 큐에 "폐기:" prefix 라벨로 update해 운영팀 처리 유도가 현재 사실상 유일. | [`mini-apps.md`](./mini-apps.md) "Drift / 폐기 시도" |
| `GET /mini-app/<id>/runtime-logs` (또는 동치) | 미니앱 서버 런타임 로그(stdout/stderr, exception, request log) 노출 endpoint 자체가 없음. 콘솔이 surface하는 건 `app events` (커스텀 이벤트 카탈로그) + `app metrics` (전환 지표)뿐. `aitcc app logs`는 backend가 생길 때까지 deferred. | [`mini-app-misc.md`](./mini-app-misc.md) "Logs", `console-cli` `CLAUDE.md` "App runtime logs" |
| Mini-app 자체에 대한 `PUT` / `PATCH` | 콘솔 번들 어디에도 mini-app path의 PUT/PATCH 호출이 없음. `/mini-app/<id>/meta/edit` UI도 form 제출 시 `POST /mini-app/review`에 `miniAppId` 포함 → dual-mode (위 update mode 참조). | [`mini-apps.md`](./mini-apps.md) "Update mode" 도입부 |
