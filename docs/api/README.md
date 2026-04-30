# Apps in Toss console — API inventory

`console-cli`(`aitcc`)가 호출하는 모든 콘솔 API의 **확정된 shape + 캡처된 샘플 데이터**를 도메인별로 정리한 문서다.

코드(`src/api/*.ts`, `src/commands/*.ts`)의 짝 문서. 콘솔 UI 변경으로 인한 drift를 추적하고, 새 명령을 추가할 때 추측 없이 첫 시도를 정확히 만드는 것이 목표.

> ⚠️ **공식 API가 아니다.** 토스가 공개·문서화한 API가 아니라, 공개 개발자 콘솔 SPA(`apps-in-toss.toss.im/console`)가 사용자 인증 세션 안에서 호출하는 내부 endpoint들의 **관찰된 동작**이다. 콘솔 UI 변경 시 깨질 수 있다. 자세히는 `console-cli` repo 루트 `CLAUDE.md` 참고.

## 색인

도메인별 캡처 상태:

| 도메인 | 파일 | 상태 |
|---|---|---|
| 공통 규약 | [`_conventions.md`](./_conventions.md) | — |
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
