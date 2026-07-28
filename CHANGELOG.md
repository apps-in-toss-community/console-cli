# @ait-co/console-cli

## 0.1.48

### Patch Changes

- aece5c6: 문서·주석에서 잘못된 슬래시 명령 표기 `/ait <verb>`(공백)를 `/ait:<verb>`(콜론)로 수정

  agent-plugin 설치 시 플러그인 이름이 명령 네임스페이스가 되므로 실제 형태는 콜론이다 — 공백 형태는 `Unknown command: /ait`만 낸다. `CLAUDE.md`와 `src/commands/keys.ts`의 `--json` 계약 주석에 남아 있던 잘못된 표기를 바로잡았다. 동작 변화 없음.

- b00cf35: `app ads placement-groups ls`의 휴먼 출력이 실제 응답 키를 읽도록 수정 — 지면마다 식별자와 상태가 `-`로 죽던 문제(#240)

  렌더러가 `id`/`status`를 읽었지만 응답의 키는 `groupId`/`state`다. `--json`은 응답을 그대로 흘려보내므로 영향이 없었고, 그래서 무증상으로 남아 있었다. 컬럼 헤더(`GROUP ID / NAME / STATE`)를 추가하고, 키 계약을 고정하는 유닛 테스트를 넣었다.

  `placement-groups create`는 더 이상 `상태: REGISTERING`을 인쇄하지 않는다 — 서버가 확인해 준 적 없는 값이었다. 출처가 있는 "구글 반영까지 최대 2시간" 안내만 남기고, 실제 상태는 `ls`로 확인하도록 가리킨다.

## 0.1.47

### Patch Changes

- 915de2a: feat(ads): `app ads placement-groups create`의 `--category`를 선택 입력으로 — 비배너(전면·리워드) 포맷에서 생략 시 미니앱 자신의 category id(`impression.categoryPaths[].category.id`)를 auto-resolve하고 `in-app-ads-v2/category/:id/ad-mob-ad-info/:format`으로 검증한다. `--category`는 override로 유지. categoryPaths가 없거나 검증 실패 시 `--category` 명시를 요구하는 에러로 degrade.
- 0e29c3c: `aitcc app ads placement-groups create`를 추가했다 — 인앱광고 지면(광고 그룹)을 생성하는 mutation 명령이다. `--format BANNER|INTERSTITIAL|REWARDED`에 따라 포맷별 필수 필드(배너는 `--banner-style`, 전면·리워드는 `--category`, 리워드는 추가로 `--reward-unit`/`--reward-amount`)를 검증해 바디를 조립한다. `aitcc app iap products create`와 동일한 `--dry-run`/`--confirm` mutation 게이트를 따른다.

  2026-07-24 3소스 교차 규명 결과, Toss 인앱광고는 개발자의 Google AdMob 계정 없이도 지면을 만들 수 있다 — 미디에이션 구성을 앱 카테고리 기준으로 Toss가 자동으로 한다. 생성 성공 시 발급된 `adGroupId`와 함께 "구글 등록까지 최대 2시간", "실서빙은 사업자·정산 승인 후"라는 안내, SDK 사용 힌트(`GoogleAdMob.loadAppsInTossAdMob`)를 출력한다.

  전면·리워드형에 필요한 `categoryId`의 후보 목록을 반환하는 조회 API는 아직 찾지 못했다 — `--category`는 항상 필수 입력이고, 상세는 `docs/api/in-app-ads.md` "category 후보 조회 — 미해결" 참고.

- bff3ca5: fix(ads): `app ads placement-groups create`의 SDK 안내 문구에 실기기 caveat 추가 — "개발 중 테스트는 ait-ad-test-\* ID를 쓰세요"만 인쇄하면 테스트 ID가 실기기에서 항상 로드된다는 뜻으로 읽힌다. 2026-07-25/26 env3 실측에서 테스트 ID와 자체 발급 실 지면이 동일하게 `PLACEMENT_ID_FETCH_FAILED`로 실패했으므로, 승인·배포 상태에 따라 테스트 ID도 로드에 실패할 수 있다는 단서를 같은 줄에 덧붙인다. (실패 원인이 승인 게이트인지 `PREPARE` 배포 상태인지는 미해결 — 문구도 단정하지 않는다.)
- abdf53e: `aitcc app iap products create`의 생성 계약을 2026-07-25 콘솔 SPA 재측정 결과(issue #232)에 맞춰 갱신했다. 플래그를 `--icon-img-url`→`--icon`, `--min-deployment-id`→`--min-deployment`, `--post-inspection-status <S>`→`--expose`(불리언)로 정리하고, `--price`는 10원 단위로 스냅해 범위를 검증하며 스냅 시 경고를 낸다(`warnings` — json/stderr). `--renewal-cycle`/`--discount`는 `--type SUBSCRIPTION`이 아니면 조용히 버리지 않고 거부한다(fail fast). `--discount <spec>`을 새로 지원한다 — citty(0.2.2)에 반복 플래그를 배열로 모으는 기능이 없어 `;`-구분 다중 entry를 담는 단일 플래그로 구현(`FREE_TRIAL`/`NEW_SUBSCRIPTION`/`RETURNING` discountPolicies 조립, `src/commands/app-iap.ts#parseDiscountPoliciesSpec`).

  `--confirm` 경로는 실제 POST 전에 read-only `catalogs` preflight를 거쳐, `errorCode: 5001`(IAP 위탁매매 약관 미동의)을 만나면 POST를 시도하지 않고 `aitcc workspace terms --type IAP`를 가리키는 힌트로 중단한다(`hintForErrorCode`에 5001 케이스 추가 — 동의는 법적 결정이라 CLI가 대신 처리하지 않음). `--min-deployment`의 APPROVED-배포 검증은 클라이언트에서 확정 관측된 API 응답이 없어 follow-up으로 남겼다(플래그 존재 여부만 검증, help text에 명시).

  `app ads placement-groups create`보다 강한 게이트(생성 = 심사 제출)라는 점을 명령 설명·거부 메시지에 명시했고, 성공 출력에 "노출은 심사 APPROVED 후"와 SDK 소비 힌트(`IAP.getProductItemList()` → `createOneTimePurchaseOrder`)를 추가했다. `docs/api/in-app-purchase.md`의 "products create" 섹션을 ⚠️ inferred에서 ✅ confirmed로 갱신 — 승인 전 create는 광고와 달리 막힐 개연성이 높다는 점을 명시.

- 4b053ab: 수익화 상태를 조회하는 read-only 명령 5종을 추가했다: `aitcc app ads placement-groups ls` / `aitcc app ads abuse-status`(인앱 광고 지면·어뷰징 상태), `aitcc app pay-config show`(토스페이 키 설정 상태), `aitcc workspace promotion-money show`(자사 앱 홍보 지출 축 — IAA 광고수익과는 다른 축), `aitcc workspace business-verification show`(사업자 라이선스 인증 + 파트너 등록 상태를 한 리포트로). 전부 2026-07-24 라이브 200 응답으로 확정된 엔드포인트(workspace 3095 / app 31146)를 기반으로 한다.

  `aitcc app pay-config show`는 5개 토스페이 자격증명 필드(`payApiKey`/`testPayApiKey`/`billingPayApiKey`/`testBillingPayApiKey`/`tossCertClientId`)의 값을 API 레이어에서부터 `'SET'|'UNSET'`으로만 마스킹한다 — Deploy Key와 동일한 시크릿 취급 원칙이며, `--json`을 포함한 어떤 출력 경로에도 원시 값이 노출되지 않는다. `aitcc workspace business-verification show`가 관측한 사업자 라이선스 미등록 신호(`errorCode: 500`)는 HTTP 실패가 아니라 SUCCESS envelope 안에 nest된 business-level 필드라, 에러로 죽지 않고 진단 메시지로 렌더링한다.

## 0.1.46

### Patch Changes

- d9ea2aa: `aitcc app show`/`aitcc app status`가 `GET /mini-app/:id/with-draft` 404로 실패하던 문제를 고쳤다 (업스트림 콘솔 API path drift). 읽기 경로를 같은 `GET /mini-app/:id`의 확장된 응답 shape(`miniApp` snapshot + `hasApproved`/`hasInReview`/`hasDraft`/`isBeforeFirstReview`/`approvalType`/`rejectedMessage`)으로 옮겼다. `app show`는 새 플래그를 additive JSON 필드로 노출하고, 더 이상 서버가 두 개의 독립된 draft/current payload를 주지 않아 `--diff`의 필드 단위 비교는 `diffAvailable: false` + 플래그 요약으로 낮췄다. `app status`의 `--json` 계약(`state`/`hasCurrent`/`hasDraft`/`locked`/`lockReason`/`approvalType`/`rejectedMessage`)은 그대로 유지된다.
- 9c49bf7: `aitcc app iap` 명령 그룹(`products ls/show/create`, `orders ls`, `refunds ls`)을 추가했다 — 미니앱의 인앱결제 상품 카탈로그·주문·환불을 조회하고, 정적 분석으로 복원한 요청 shape을 바탕으로 상품 등록(`products create`)을 `--dry-run`/`--confirm` 게이트 뒤에서 지원한다. 이 워크스페이스가 파트너(빌링/정산 주체) 미등록 상태라 대부분의 IAP 조회가 `errorCode: 5002`로 막히는데, `hintForErrorCode`가 이 코드를 만나면 `aitcc workspace partner`로 상태를 확인하라는 hint를 `--json` 여부와 무관하게 구조화된 형태로 붙이도록 확장했다.

  `aitcc workspace partner`는 `GET .../partner`와 `GET .../partner/is-registered` 두 endpoint를 병렬 호출해 `registered`/`approvalType`/`rejectMessage` 단일 상태 뷰로 병합하도록 바뀌었다(`mergePartnerStates`) — 기존 `--json` 출력 shape은 그대로 유지된다.

## 0.1.45

### Patch Changes

- ebcea9b: 셸 자동완성이 설치되어 있지 않을 때 최초 1회만 설치 방법을 안내하는 힌트를 추가한다. TTY 대화형 실행·알 수 없는 셸·`--json` 출력·`upgrade`/`completion` 명령에서는 항상 침묵하고, 힌트를 한 번 출력하거나 이미 설치됐음을 확인하면 마커 파일을 캐시에 남겨 두 번 다시 표시하지 않는다. rc 파일 자동 수정은 하지 않으며 사용자가 붙여넣을 수 있는 one-liner(`source <(aitcc completion bash)` / `aitcc completion zsh > …` / `aitcc completion fish > …`)만 stderr로 안내한다.
- b44792a: 업데이트 notice("newer aitcc available")를 `whoami`뿐 아니라 **모든 명령**에서 띄운다. probe를 단일 종료 chokepoint(`exitAfterFlush`)로 옮겨, `aitcc app deploy`·`app status` 등 어떤 명령을 돌려도 24h 스로틀 안에서 한 번 notice를 본다. non-TTY(agent/CI)·`--json` 출력·`upgrade`/`completion`은 그대로 침묵. self-update 동작은 변경 없음(notify-only).

## 0.1.44

### Patch Changes

- a22bc92: Add transparent mid-flight 401 reauth for read commands (`withReauthRetry`)

  When a live API call fails with a genuine expired-session 401 (not a geo-block),
  read-only commands now automatically re-authenticate with saved file credentials
  and replay the request once — without prompting the user or opening a browser.

  **What changed**

  - `TossApiError` gains `isGeoBlocked` (errorCode `4010`) and `isExpiredSession`
    (`isAuthError && !isGeoBlocked`) getters, so geo-blocks are never mistaken
    for expired sessions and never trigger a reauth attempt.
  - New exported `withReauthRetry<T>` helper in `_shared.ts` wraps a read
    operation: catches only `isExpiredSession` errors, loads file credentials,
    headlessly re-authenticates, and replays the call exactly once.
  - Carve-outs preserved: `AITCC_SESSION` env (CI mode) and env-sourced
    credentials (`AITCC_EMAIL`/`AITCC_PASSWORD`) skip reauth and rethrow.
  - Read commands wired: `whoami`, `app ls/show/status/bundles ls/bundles deployed`,
    `workspace ls/use/show/partner/terms show/segments ls`, `members ls`,
    `notices ls/show/categories`, `me terms show`, `keys ls`, `app init`
    (workspace fetch).
  - Mutations are intentionally NOT wrapped (deploy, register, keys create/revoke,
    members invite/remove, workspace/me terms agree) — replaying a mutation could
    double-submit.

## 0.1.43

### Patch Changes

- de0eefc: 저장된 크리덴셜을 사용한 headless 로그인이 Toss 90일 비밀번호 변경 인터스티셜 때문에 타임아웃되는 문제 수정.

  - 비밀번호 교체 인터스티셜 자동 감지 (`business.toss.im/change-password-for-security`) 및 "90일 뒤에 변경" 버튼 클릭으로 무해하게 무시 (서버 측 90일 지속)
  - submit 단계 타임아웃 메시지가 전체 `--timeout`(300s)이 아닌 실제 submit 관찰 창(30s)을 표시하도록 수정
  - submit 단계 타임아웃 시 hard exit 대신 interactive 폴백으로 전환 (step-up 타임아웃은 기존처럼 hard exit 유지)

- d7bac2d: 세션 만료 시 자동 재인증: 저장된 자격증명이 있을 때 headless 재로그인을 한 번 시도하고 투명하게 이어짐 (#206)

## 0.1.42

### Patch Changes

- 32ff350: 5010(AI 위험 고지·이용약관, `AI_RISK_USE`) 게이트를 에러 전에 선제 감지·안내. `keys create`·`app deploy`가 실 호출 전에 `probeAiRiskTerms`(best-effort, bounded GET)로 동의 상태를 확인해 미동의 시 약관 title·`contentsUrl`과 `aitcc me terms agree --scope AI_RISK_USE` 안내를 stderr로 출력(권위 게이트는 실 API — preflight 실패/timeout은 silent skip 후 진행). `--json`에선 human 경고를 생략해 stdout은 단일 JSON 라인 유지. `app deploy --dry-run`이 그동안 못 보던 5010을 `terms.blockers`(`errorCode 5010`)·경고 열거에 추가. `whoami`에 AI risk 약관 동의 상태 한 줄/`aiRiskTerms` 필드 노출. 막혔을 때 `hintForErrorCode('5010')` 안내를 약관 확인·동의 경로·법적 동의 주의까지 강화(preflight 경고와 remedy 문구 단일 정본 공유).

## 0.1.41

### Patch Changes

- 82ae46a: AI 위험 고지·이용약관(`AI_RISK_USE`) 동의를 aitcc로 처리. `me terms --scope AI_RISK_USE`로 약관을 조회하고 `me terms agree --scope AI_RISK_USE`로 동의한다(법적 동의 게이트 — `contentsUrl`/title 표시 후 인터랙티브 `y/N` 또는 `--json`/non-TTY는 `--yes` 요구, 자동 동의 없음). 계정-level `console-user-terms/me` GET(`?termsScope=AI_RISK_USE`)·POST 엔드포인트를 `src/api/me.ts`에 추가. `keys create`·`app deploy` 등이 errorCode 5010(`혁신금융서비스_약관_미동의`)으로 막히면 `aitcc me terms agree --scope AI_RISK_USE`로 동의하라는 seam hint를 자동 emit.

## 0.1.40

### Patch Changes

- d655835: telemetry 코드 전면 제거 — src/telemetry/ 디렉토리, `aitcc telemetry` 서브커맨드, cli.ts 배선, README ko/en 텔레메트리 섹션을 완전 제거. 추후 일관된 단일 설계로 재구현 예정.

## 0.1.39

### Patch Changes

- 087b752: `keys create` now automatically saves the issued Deploy Key to `~/.ait/credentials` under the `--name` profile so `ait deploy --profile <name>` works immediately without a separate `ait token add` step. Pass `--no-save-profile` to skip (stdout-only, for CI pipes). Also fixes the `~/.ait` directory permissions to `0700` (was missing mode, defaulted to `0755`).

## 0.1.38

### Patch Changes

- 8d95db3: refactor(auth): OS keychain 완전 제거 — file-only credential store(~/.config/aitcc/credentials.json, perm 0600)로 통일. 기존 keychain 자격증명은 첫 명령 실행 시 자동 마이그레이션됨.

## 0.1.37

### Patch Changes

- 465dd01: feat(auth): SSH/headless 세션 keychain 우회 — --save=file 옵션 + login 실패 시 unlock-keychain 안내.

## 0.1.36

### Patch Changes

- d009a58: fix(api): bundles test-links missing deploymentId query → 4000

## 0.1.35

### Patch Changes

- e469023: `serviceStatus: OPENED`를 라이브(in-service) 값으로 인식한다. `app ls`가 출시된 앱을 bare `approved` 대신 `in-service`로 표시하고, `app status`/`app show`가 `OPENED (출시 중)` 라벨을 붙인다. 기존 `RUNNING`은 tolerated alias로 유지.

## 0.1.34

### Patch Changes

- 05ef2a0: Fix three correctness/contract bugs found in a cross-repo review sweep:

  1. **subtitle length uses codepoints, not UTF-16 units** (`src/config/app-manifest.ts`): `subtitle.length` counted UTF-16 code units, so a valid 20-emoji subtitle (20 codepoints, 40 code units) was wrongly rejected. Now uses `[...subtitle].length` (same approach as the adjacent `description` check).

  2. **partial-failure auth error emits `ok: false`** (`src/commands/app-deploy.ts`): when the upload succeeded but the downstream review/release step failed due to a session expiry, the emitter was emitting `ok: true` — making a failed deploy look like a success to `--json` consumers. Changed to `ok: false` while keeping `authenticated: false` and `reason: 'session-expired'` so callers can still distinguish the auth case. Updated the `--json` contract comment to document the corrected shape.

  3. **`app-not-found` reason documented but never emitted** (`src/commands/app.ts`): the `--json` contract comment for `app show` promised `{ reason: 'app-not-found' }` at exit 2, but the implementation never emits it — a missing app surfaces via the generic `api-error` handler at exit 17. Corrected the comment to reflect the real behaviour.

## 0.1.33

### Patch Changes

- fe6009e: fix: three correctness defects — register write-back for string miniAppId, appName validation, empty release-notes guard

  - `app register`: `persistMiniAppIdToProject` now coerces a string-typed `miniAppId` (e.g. `"31146"`) returned by the API before the numeric guard, so the write-back to `aitcc.yaml` is no longer skipped when the API returns the id as a string.
  - `app-manifest`: `validateManifest` now validates `appName` against `APP_NAME_REGEX` (kebab-case, lowercase-leading), consistent with all other field validations. Invalid slugs throw `ManifestError` with `field: 'appName'`.
  - `app deploy`: the `--release-notes` guard now rejects empty strings and whitespace-only values in addition to `undefined`, preventing a silent bypass of the "release notes required" check when `--request-review` is set.

## 0.1.32

### Patch Changes

- ab73930: Fix dry-run workspace terms blocker action to use `terms agree` instead of `terms --type`
- 394d6a0: Use "Deploy Key" in `keys` subcommand help text and runtime output (was "API key")

## 0.1.31

### Patch Changes

- 89562e7: `aitcc login`의 headless form-fill 흐름을 토스 비즈니스 sign-in 페이지 최신 구조(Radix UI)에 맞춰 갱신했습니다. 새 폼은 `name` 속성이 없고 email input이 `type="text"`라 기존 selector가 빈손으로 떨어져 `form-fill-find-email`로 interactive fallback이 항상 발생했습니다.

  새 picker는 (1) `aria-label` / `placeholder`의 "이메일" / "비밀번호" 텍스트, (2) password input의 `closest('form')` 안에서 password 앞에 위치한 첫 text/email input을 마지막 fallback으로 사용합니다. password 폼 anchor 덕분에 무관한 검색 박스가 자격증명을 받을 위험은 그대로 차단됩니다.

  `aitcc login` 사용자 영향: TTY에서 credential을 입력하거나 keychain에 저장해 둔 경우 다시 headless 흐름이 정상 동작합니다. `--interactive` 사용자는 이전과 동일.

  Update the headless form-fill flow in `aitcc login` to track the latest Toss Business sign-in page (Radix UI). The new form has no `name` attributes and the email input is `type="text"`, so the previous selectors always missed and we fell back to interactive with `form-fill-find-email`.

  The new picker matches on `aria-label` / `placeholder` containing "이메일" / "비밀번호", and falls back to the first text/email input that appears before the password input inside the same `<form>` — anchoring on the password input keeps a stray search box from capturing credentials.

  User impact for `aitcc login`: users with credentials in TTY prompt or saved in the OS keychain get the headless flow working again. `--interactive` users are unaffected.

## 0.1.30

### Patch Changes

- b8fa51c: Tier 0 익명 일별 핑 추가 및 Tier 1 텔레메트리 유지 (policy_version `2026-05-18` 범프).

  Add Tier 0 anonymous daily ping (opt-out) alongside retained Tier 1 opt-in events; bump policy_version to 2026-05-18.

## 0.1.29

### Patch Changes

- 52557be: docs(npm): fix description (remove MCP language), drop mcp keyword, add badges.
- d7f043f: feat(telemetry): add opt-in anonymous usage telemetry client.

  - New `src/telemetry/` module: `state.ts` (consent + anon_id persistence in `~/.config/aitcc/telemetry.json`), `send.ts` (fire-and-forget POST with one retry), `index.ts` (endpoint selection, first-run consent prompt, install marker).
  - Events: `cli_invoked` (every command, meta: `{command}`), `cli_install` (first run after grant, meta: `{platform, arch}`).
  - Consent: opt-in only. First run on TTY prompts `[y/N]`; non-TTY defaults to deny. `AITCC_TELEMETRY_ENV=staging` routes to `t-staging.aitc.dev`; dev builds (`-dev` VERSION) auto-route to staging.
  - New `aitcc telemetry status/enable/disable/delete` subcommands. `delete` sends `DELETE /e?anon_id=...` and rotates local anon_id.
  - Policy-version bump rule: previously-granted consent reverts to undecided when `CURRENT_POLICY_VERSION` changes (same pattern as devtools).
  - 15 new unit tests (mock fetch, consent state machine, deleteMyData, retry).
  - README (ko + en) updated with Telemetry section.

  NOTE: metrics-ingest `source` allowlist still needs `['devtools', 'console-cli']` + `policy_version` bump — that is a separate follow-up PR on the metrics-ingest repo.

## 0.1.28

### Patch Changes

- 503609e: Add `aitcc members invite <email>` and `aitcc members remove <bizUserNo>` subcommands.

## 0.1.27

### Patch Changes

- 0b41751: feat(register): wire manifest `miniAppId` into update-mode payload

  The server `POST /workspaces/:wid/mini-app/review` endpoint already runs
  dual-mode (absent `miniApp.miniAppId` → create, present → update existing
  draft and re-enter review queue) per `docs/api/mini-apps.md`. The CLI side
  was hardcoded to create-only: yaml `miniAppId: 31146` was parsed and
  write-back-eligible but never forwarded into the submit body.

  Changes:

  - `AppManifest.miniAppId?: number` validated as positive integer; `null`
    treated as absent (create mode).
  - `MiniAppSubmitPayload.miniApp.miniAppId?: number` threaded through
    `buildSubmitPayload` only when manifest provides it.
  - `aitcc app register` prints `[mode: update · miniAppId N] existing app
draft will be overwritten and re-enter the review queue.` to stderr in
    non-JSON mode so the operator knows they are updating, not creating.

  Verified against 31146 with `--dry-run --json`: payload now includes
  `"miniAppId":31146` (previously absent). Closes the reject → re-asset →
  resubmit feedback loop without the console web UI detour.

## 0.1.26

### Patch Changes

- 79df75d: chore(deps): bump @biomejs/biome 2.4.15, tsdown 0.22.0, yaml 2.8.4
- c08ef21: chore(deps): bump vitest to 4.1.5 (patch); isolate XDG_CONFIG_HOME in credentials env-source tests so a developer's real `~/.config/aitcc/auth-state.json` doesn't leak into the suite

## 0.1.25

### Patch Changes

- 4b0f461: `aitcc login`이 첫 실행에서 email/password/저장 위치를 한 번에 묻는 interactive flow로 통합됐습니다. CI/script에선 `--email` + `--password-stdin`으로 동등 동작. 흩어져 있던 `aitcc auth set/clear/status`는 `aitcc login` (interactive prompt) / `aitcc logout --purge` / `aitcc whoami`로 흡수되며 deprecated 명령은 한동안 redirect로 그대로 동작합니다.

## 0.1.24

### Patch Changes

- 2de555a: `aitcc app certs ls`가 만료 임박 cert를 ⚠ 마커로 강조하고 JSON 응답의 각 cert에 `daysUntilExpiry`(`number | null`)를 추가합니다. 내부적으로 cert API를 도메인 파일(`src/api/certs.ts`)로 분리하고 `--json` 단일라인 contract를 subprocess harness로 검증합니다.
- ef6be95: Add `aitcc app certs show <certId>` to surface a single mTLS cert's metadata in one round-trip — derives `daysUntilExpiry` (D-N or "expired N day(s) ago") so agents can verify expiry without parsing `app certs ls` output. The console has no per-cert detail endpoint, so this reuses the list fetch with client-side filter; PEM material is never on list responses. `export` is intentionally not added — the console only emits PEM at issue time and exposes no re-download path. If you lost the `--out` backup, `revoke` + `issue` to roll a new cert.
- dd9f74d: `aitcc app deploy --dry-run`이 단순 echo에서 전체 사전 검증으로 강화됩니다. 번들 무결성, deploymentId 일치, workspace/app/session 컨텍스트, 권한, 약관 미동의 차단 항목을 한 번에 리포트해 라이브 deploy 전에 발화 가능한 실패를 모두 미리 잡습니다.

## 0.1.23

### Patch Changes

- 6eb27e7: Add `aitcc app init` to scaffold a well-formed `aitcc.yaml` interactively.
  Required fields are validated against the same constraints `register`
  enforces; optional fields are pre-laid as commented lines for later
  edits. Workspace is selected from the live API list, and the resulting
  file pins `workspaceId` so subsequent commands inherit the project
  context without flags.
- 190518a: `aitcc app ls`가 status 컬럼을 채워 출력합니다. 검수 중인 앱은 🔒 표시 +
  JSON에 `status` (`under-review` / `approved-with-edits` / `approved` /
  `in-service` / `rejected` / `not-submitted` / `unknown`), `locked`,
  `lockReason` 필드.
- 6e6622e: `aitcc app show`가 review lock 상태와 service status(`PREPARE`/`RUNNING`/...)를 같이 표시합니다. `--diff` 플래그로 draft와 current view를 한 번에 비교할 수 있습니다.
- 5235833: `aitcc app status`가 update lock 상태를 명시적으로 surface합니다. JSON에 `locked`/`lockReason` 필드, plain mode에는 경고 줄을 추가했습니다. 권위 source는 `with-draft.success.approvalType === 'REVIEW'` — derived `state` (`approved-with-edits`/`under-review`) 만으로는 lock 해제 여부를 알 수 없습니다.
- 566410c: `aitcc auth export` / `auth import` 추가. 로컬에서 잡은 console session을 portable blob으로 dump하고 `AITCC_SESSION` env로 복원해 단발성 CI 배포에 쓸 수 있습니다. env 모드에서는 `writeSession` / `clearSession`이 no-op이라 CI 호스트에 세션 파일이 만들어지지 않습니다. **세션 쿠키는 KR-only** (한국 외 IP에선 401/`errorCode: 4010`) — GHA-hosted runner는 작동하지 않습니다. 자세한 제약은 `docs/api/auth-session.md`.
- 3f77571: `aitcc login` 첫 실행 시 자격 증명을 OS 키체인에 저장할지 묻는 onboarding 프롬프트를 추가하고, 사용자-facing 명령 `aitcc auth set` / `aitcc auth clear` / `aitcc auth status`를 노출한다. 프롬프트는 `--json`, 비-TTY, `--skip-onboarding`, 이미 자격 증명이 있는 경우엔 표시되지 않는다. `auth set` 비대화형 사용 시 `--password`는 `ps`/Task Manager에 노출되므로 `AITCC_PASSWORD` 환경 변수 사용을 권장하는 stderr 경고를 출력한다.
- 684aee6: Add `src/auth/credentials.ts` library for persisting Toss Business email + password across the OS keychain (macOS `security`, Linux `secret-tool`, Windows PowerShell + CredWrite). `loadCredentials()` resolves from `AITCC_EMAIL`+`AITCC_PASSWORD` env first, then falls back to the keychain entry pointed to by `auth-state.json`. `saveCredentials()` is no-op (`status: 'unchanged'`) when the same email + password is already stored. Library only — no CLI surface yet; wiring into the form-fill login path lands in a follow-up PR.
- 8c363ed: `aitcc login`이 headless 시도가 실패해 visible Chrome으로 fallback할 때, 첫 시도가 이미 소비한 시간을 사용자의 `--timeout` 예산에서 차감한다. 30초 minimum floor가 보장되어 짧은 timeout에서도 사용자가 폼을 채울 시간을 확보. 사용자가 `--timeout 30`으로 호출했는데 headless가 25초를 먹고 fallback해도 visible 창은 30초의 입력 시간을 받는다 (전체 명령은 요청한 timeout보다 약간 길게 실행될 수 있음).
- d428d04: `aitcc login`이 저장된 자격 증명으로 headless 로그인을 시도하고, step-up 인증이 필요하거나 자격 증명이 없으면 기존 interactive 흐름으로 자동 fallback한다. `--interactive` 플래그로 강제 우회 가능. `--json` 출력에 `mode` (`headless` | `interactive`) 와 `stepUp` 필드 추가.
- 0236784: `install.sh`가 `$HOME` unset/empty/missing 환경(일부 minimal Docker, CI)에서 `/tmp/aitcc-install`로 fallback하고, GitHub Release asset 업로드 race로 인한 404를 최대 30초 exponential-backoff(1s → 2s → 4s → 8s, 8s cap)로 재시도한다. 404 외의 status는 즉시 fail해 진짜 breakage를 mask하지 않으며, retry 후에도 SHA-256 검증은 항상 수행된다.
- ab1b702: `--json` 계약을 subprocess 레벨에서 검증하는 vitest harness를 확장. built CLI를 spawn해 stdout이 단일-라인 JSON임을 자동 보증하고 stderr에 JSON이 새지 않는지 점검한다. workspace/whoami/app/logout/auth/--version/unknown-command 12개 케이스. 사용자에게 보이는 동작 변경은 없다.
- 99594fa: `aitcc keys create --name <label> [--apps <slug,slug>]` / `aitcc keys revoke <id>` 추가. 발급 응답의 plaintext key는 stdout에 한 번만 surface되고 list endpoint는 이를 echo하지 않으므로 즉시 secret manager에 저장해야 합니다 (`aitcc keys create --json`을 keychain pipe에 직접 연결). `keys ls`도 confirmed shape(`{id, name, expireTs}`)에 맞춰 D-N expiry 컬럼을 추가했습니다. endpoint/payload 상세는 `docs/api/api-keys.md`.
- 4880434: Recognize prefix-form `errorCode` values (`<domain>.<Reason>`, e.g. `miniApp.InvalidTitle`) emitted by `POST /workspaces/:wid/mini-app/review` alongside the legacy numeric codes. Known prefix codes are mapped to a one-line user action in `--json` and stderr output (raw `errorCode` is preserved); unknown prefix codes surface the dotted identifier so it can be looked up in `docs/api/_error-codes.md`. Numeric codes (`4046` / `4032` / `4010` / …) keep existing behaviour byte-for-byte. Discovered during sdk-example#39 dog-food.
- efb9940: Add `aitcc.yaml` project context resolver: ancestor-walk loader (`findProjectContext`) and priority-chain resolver (`resolveAppContext`) that combines `--workspace`/`<appId>` flags, `AITCC_WORKSPACE`/`AITCC_APP` env vars, yaml fields, and the persisted session. No commands are wired to it yet — wiring lands in a follow-up PR.
- 7e94d6b: Drop the `type=text` fallback from the headless login email-input picker. If a search box or other unrelated text input were rendered above the sign-in form, the previous fallback would have silently typed the email and password into it in plaintext. The picker now matches by `name` (`email`/`loginId`/`username`) and falls back only to `type=email`, which is semantically unambiguous.
- 334f2fb: Best-effort 정리: `aitcc whoami`/`upgrade` 등의 update-check cache write 도중 SIGKILL/power-loss로 남을 수 있는 7일 이상 stale `.tmp` 파일을 다음 cache write 시 자동으로 청소합니다. 정상 동작에는 변화 없음.
- 19cc987: Windows에서 `aitcc upgrade` 후 남은 `<exePath>.old` 파일을 다음 CLI 기동 시 best-effort로 정리합니다. POSIX에선 no-op, 실패는 silently swallow (이전 process가 아직 잡고 있을 수 있음 — 다음 기동 때 재시도). stdout/stderr 출력 없음.
- 68895c5: `aitcc workspace terms`가 각 약관이 미동의일 때 어떤 명령이 막히는지 `blocks if missing: …` 한 줄 hint로 표시합니다. JSON에 `blocks` 필드 추가.
- 1ded85b: `aitcc app register` now writes the returned `miniAppId` back into the resolved `aitcc.yaml`/`aitcc.json` after a successful submit, so follow-up commands like `app status` and `app deploy` resolve the same app without an explicit `--app`. YAML round-trips comments and key order; the write is a no-op when the file already pins the same id; `--dry-run` skips it; if no project file exists in the tree, a one-line stderr hint is printed instead of creating one.

## 0.1.22

### Patch Changes

- 059df1d: darwin 바이너리 서명 경로에서 `rcodesign` 외부 의존을 제거하고 stock `codesign --sign - --options runtime`으로 통합한다. Bun 1.3.13(`engines.bun` 핀)이 만드는 `linker-signed` ad-hoc stub을 `codesign --remove-signature`로 벗기고 hardened runtime + ad-hoc로 재-사인 — teleprompter에서 production 검증된 동일 패턴. 부산물로 `scripts/macos-entitlements.plist` 삭제(ad-hoc + non-hardened 서명에선 entitlements가 사실상 no-op이고 hardened runtime 위에서도 ad-hoc은 entitlements를 의미 있게 부여하지 못함). `scripts/build-bin.ts`의 darwin 분기 인라인 서명도 제거 — signing은 CI workflow 단계로 일원화. install.sh의 `xattr -d com.apple.quarantine` + 재-사인 안전망은 그대로 유지.

## 0.1.21

### Patch Changes

- e511047: 플랫폼 바이너리 빌드 toolchain의 Bun 버전을 `1.3.13`으로 핀한다 — `package.json`의 `engines.bun: "1.3.13"`으로 선언, `oven-sh/setup-bun@v2`가 이 필드를 자동 인식해 CI에서 동일 버전을 설치한다 (`packageManager`는 이미 pnpm이 점유하므로 `engines` 경로 사용). `@types/bun`도 `^1.3.13`으로 맞춤. 1.3.13은 macOS Mach-O `LC_CODE_SIGNATURE` stub 문제를 업스트림에서 수정한 버전 — 이 PR은 핀만 하고 rcodesign ad-hoc 서명 우회 제거는 후속 PR에서 별도로 검증한다.
- 7f7db06: `app register` 매니페스트 단계에서 `titleKo` / `titleEn`을 미리 검증해 server-side reject (errorCode `miniApp.InvalidTitle{,En}`) round-trip을 없앤다. titleKo는 한·영·숫자·공백·`:·?`만 허용 + 공백 제외 ≤10 code points, titleEn은 정규식 `^[A-Za-z0-9 :·?]+$` + 공백 제외 ≤15 code points + 단어별 title-case (all-caps 토큰 reject).

## 0.1.20

### Patch Changes

- 259e4ec: Manifest auto-detect now uses `aitcc.yaml` / `aitcc.json` (was `aitcc.app.yaml` / `aitcc.app.json`). The `.app` middle token is removed; legacy filenames are no longer recognized. Pass `--config` explicitly if you need to keep the old name.

## 0.1.19

### Patch Changes

- fd3732e: test: add subprocess harness covering `aitcc workspace --json` failure paths (single-line framing, JSON shape, exit codes, stderr-has-no-JSON).

## 0.1.18

### Patch Changes

- 3c4f357: `aitcc upgrade`가 atomic replace 직후 새 binary로 `--version` smoke test를 수행하고, 실패하면 이전 binary로 자동 롤백한다. 새 exit code `UpgradeSmokeTestFailed` (23) 추가.

## 0.1.17

### Patch Changes

- 0151143: Verify SHA-256 of downloaded binary in `aitcc upgrade` before atomic replace

## 0.1.16

### Patch Changes

- 2ea3e26: fix(app deploy): accept both AIT header format and legacy zip bundles

  `@apps-in-toss/web-framework`'s build toolchain switched to an `AIT`
  wrapper format (`AITBUNDL` magic + big-endian header + protobuf
  `AITBundle` + inner zip blob); legacy toolchains still emit plain zips.
  The console's uploader branches on the first 8 bytes and handles both,
  but `aitcc app deploy` was parsing the file as a zip unconditionally
  and would reject modern bundles with `invalid-zip`.

  `src/config/ait-bundle.ts` now:

  - detects the format via magic bytes (`AITBUNDL` → AIT, `PK\x03\x04` → zip),
  - reads `deploymentId` directly from the AIT protobuf header for AIT
    files (via a minimal inline wire-format decoder — no `protobufjs` /
    `long` runtime dependency), and
  - keeps the existing `fflate` `app.json` extraction path for legacy zips.

  New `AitBundleErrorReason` values: `unrecognized-format` (neither magic
  matches) and `invalid-ait` (truncated or malformed AIT header).
  `readAitBundle` / `deploymentIdFromBundleBytes` now also surface the
  detected `format: 'ait' | 'zip'`, and `aitcc app deploy --json`
  includes `bundleFormat` in both dry-run and success output so
  `agent-plugin` can tell which toolchain produced the bundle without
  re-reading the file.

## 0.1.15

### Patch Changes

- b61a117: docs: record that the console exposes no runtime-log endpoint

  Full static analysis of `bootstrap.N0Zaulo0.js` (184 endpoints, 55 async
  chunks, complete mini-app route table) finds zero runtime-log surface —
  the three `/log/*` endpoints in the bundle are all about the **custom
  analytics event catalog** (keyed on `logName`), same thing `aitcc app
events` already wraps. `aitcc app logs` is deferred until a backend log
  endpoint actually exists; see `.playwright-mcp/LOGS-NOT-FOUND.md` for
  the full procedure so the next attempt can pick up where this one left
  off.

- 12a6036: docs: close out root-level `aitcc status` from TODO

  TODO.md originally had `aitcc status [appId]` as a planned root-level
  command alongside `app status`. Now that `aitcc app status <id>` is
  implemented with `--watch` / `--json` / `--workspace` and fuses the
  client-derived review state with the server's `serviceStatus`, the
  root-level alias isn't worth the surface area: it would either
  duplicate `app status` (saving 4 characters) or require a
  "selected-app" mode-state the session deliberately doesn't keep.

  Marks the item complete in TODO and adds a "왜 top-level `aitcc
status`가 없는가" rationale note in CLAUDE.md so future sweeps don't
  re-open this question. No code changes.

- 019a5fc: feat(app): bundle upload/review/release/test-push commands

  Adds the full write-path for shipping bundles to mini-apps:

  - `aitcc app bundles upload <id> <path> --deployment-id <uuid> [--memo]` —
    3-step deploy dance observed in the console UI:
    `POST /deployments/initialize {deploymentId}` →
    `PUT <uploadUrl>` (S3 presigned, Content-Type `application/zip`) →
    `POST /deployments/complete {deploymentId}` →
    optional `POST /bundles/memos {deploymentId, memo}`.
    Refuses if initialize returns `reviewStatus !== PREPARE` (matches the
    console's "이미 존재하는 버전이에요." guard). `--dry-run` shows what
    would be sent without touching the server.
  - `aitcc app bundles review <id> --deployment-id <uuid> --release-notes <text>` —
    `POST /bundles/reviews`. `--withdraw` sends
    `POST /bundles/reviews/withdrawal` instead.
  - `aitcc app bundles release <id> --deployment-id <uuid> --confirm` —
    `POST /bundles/release`. Guarded behind `--confirm` because the bundle
    goes live to end users.
  - `aitcc app bundles test-push <id> --deployment-id <uuid>` —
    `POST /bundles/test-push`.
  - `aitcc app bundles test-links <id>` — `GET /bundles/test-links`.

  `deploymentId` is the `_metadata.deploymentId` written into the `.ait`
  bundle's `app.json` by the build toolchain; for now the CLI takes it as
  an explicit flag. Zip cracking is a follow-up.

- cd34b41: feat(app): deploy one-shot wrapper (upload + review + release)

  Adds `aitcc app deploy <path> --app <id>` — a convenience wrapper that
  chains the bundle pipeline. Before this, shipping a bundle meant
  running three separate commands (`bundles upload` → `bundles review` →
  `bundles release`) while carrying the same `--deployment-id` by hand.

  The wrapper:

  - Auto-detects `_metadata.deploymentId` from the `.ait` by cracking the
    zip (via `fflate`) when `--deployment-id` is omitted — users no
    longer need to open the bundle themselves.
  - Always performs the 3-step upload (initialize → PUT → complete, +
    optional memo).
  - `--request-review --release-notes <text>` additionally submits the
    bundle for review.
  - `--release --confirm` additionally publishes an APPROVED bundle.
    (Typically a second `app deploy` run, since a freshly uploaded
    bundle is not yet APPROVED.)
  - `--dry-run` prints the planned pipeline without touching the server.
  - Partial-success `--json` reports `uploaded`/`reviewed`/`released`
    flags so `agent-plugin` can resume at the failing step on retry
    without re-uploading.

  Internal additions:

  - New runtime dependency: `fflate` (~8 KB, zero deps) for zip reads.
  - New module: `src/config/ait-bundle.ts` — pure bundle reader, unit-
    tested with synthesized zips (`src/config/ait-bundle.test.ts`).
  - New command module: `src/commands/app-deploy.ts`, exporting
    `runDeploy` as the testable seam (same pattern as `runRegister`).

## 0.1.14

### Patch Changes

- a4960f8: Add `aitcc completion <bash|zsh|fish>` to emit shell completion scripts.

  Static, shallow design: top-level commands and one level of subcommands (e.g. `aitcc workspace <TAB>` → `ls partner segments show terms use`). Deeper (3rd+ word) completions fall through to the shell's default filename completion, which is fine for positional app/workspace IDs.

  Install one-liners per shell:

  - bash: `source <(aitcc completion bash)` in `~/.bashrc`
  - zsh: `aitcc completion zsh > "${fpath[1]}/_aitcc"`
  - fish: `aitcc completion fish > ~/.config/fish/completions/aitcc.fish`

  `install.sh` now detects `$SHELL` and prints the appropriate one-liner after install. User rc files are not modified automatically.

  `--json` emits `{ok: false, reason: 'invalid-shell', allowed: [...], message}` on bad input so agent-plugin can capability-probe.

## 0.1.13

### Patch Changes

- 6a3fa2c: `app show --view current` now prints a stderr hint when the current view is empty but a draft exists — the most common "why is this empty?" case for unreviewed apps. The JSON contract is unchanged (`miniApp: null` is still returned); only stderr diagnostics improve.
- 89489e7: `app status` now surfaces the server's `serviceStatus` (PREPARE / RUNNING / …) alongside the client-derived review state, in both JSON and plain text. Also exposes `shutdownCandidateStatus` and `scheduledShutdownAt` from the same `/review-status` endpoint, so operators can see whether an approved app is actually live — or scheduled for shutdown — without making a second `app service-status` call.

  `--watch` mode re-prints on either review-state OR service-status changes; the service-status call is best-effort, so a transient failure still lets the derived review state through.

- 8113b7b: `app register` now prints a hint pointing at `aitcc app categories --selectable` whenever the manifest validator rejects `categoryIds`. The hint is plain-text only (stderr); the `--json` payload is unchanged so agent-plugin's parser stays stable.

## 0.1.12

### Patch Changes

- 2769f76: Add `aitcc app categories` to list the impression category tree used by `app register`'s `categoryIds` field.

  Endpoint: `GET /impression/category-list` — workspace-independent lookup. Returns three groups (금융 / 게임 / 생활), each with a category list and optional sub-categories. `--selectable` collapses the output to only the entries callers may actually reference (`isSelectable: true`). Useful when authoring or validating an `aitcc.app.yaml` manifest.

- c663d07: Add `aitcc app events ls <id>` to list the custom event catalogs (log search) for a mini-app — the 이벤트 menu in the console.

  Endpoint: `POST /mini-app/:id/log/catalogs/search` with body `{isRefresh, pageNumber, pageSize, search}`. Response: `{results, cacheTime, paging: {pageNumber, pageSize, hasNext, totalCount, totalPages}}`. PREPARE-state apps return an empty `results` with a server-cache timestamp — same pattern as `conversion-metrics`.

  Flags: `--page <n>`, `--size <n>`, `--search <text>`, `--refresh` (bypass server cache). Per-event record shape is passed through opaquely until a populated response is observed.

- de2bafc: Add `aitcc app messages ls <id>` to list smart-message campaigns (the successor to the legacy 푸시알림 menu, now surfaced as 스마트 발송).

  Endpoint: `POST /mini-app/:id/smart-message/campaigns?page=&size=` with a JSON body `{sort, search, filters}`. The unusual POST-for-list shape is what the console UI sends; the CLI mirrors it so the request is indistinguishable from XHR. Response: `{items, paging: {pageNumber, pageSize, hasNext, totalCount}}`.

  Flags: `--page <n>`, `--size <n>`, `--search <text>`. Per-campaign record shape is passed through opaquely until a populated response is observed.

- df8d355: Add `aitcc app service-status <id>` to show the server-authoritative runtime state of a mini-app.

  Endpoint: `GET /mini-app/:id/review-status` (singular `mini-app` — distinct from the workspace-level `mini-apps/review-status` plural endpoint that `app ls` uses). Response: `{serviceStatus, shutdownCandidateStatus, scheduledShutdownAt}`.

  This complements `app status` (which derives state client-side from `/with-draft`) by surfacing the server's canonical `serviceStatus` string — useful for detecting shutdown schedules or when the /with-draft envelope is ambiguous.

- 0a55a3e: Add `aitcc app templates ls <id>` to list the smart-message composer templates for a mini-app (the template picker inside 스마트 발송).

  Endpoint: `GET /mini-app/:id/templates/search?page&size&contentReachType&isSmartMessage`. Response: `{page: {totalPageCount}, groupSendContextSimpleView}` — the internal `groupSendContextSimpleView` key is renamed to `templates` at the CLI layer so the output stays readable.

  Flags: `--page`, `--size`, `--content-reach-type FUNCTIONAL|MARKETING`, `--smart-message true|false`. Per-template record shape is passed through opaquely until a populated response is observed.

- c9c9143: Add `aitcc me terms` to show the console-level terms of agreement for the signed-in account.

  Endpoint: `GET /console-user-terms/me`. This is user-scoped (sibling of `workspace terms`, which is workspace-scoped). On a fresh account the result is a single `앱인토스 콘솔 이용약관` entry with `isAgreed: true` — anyone who has logged in at all has accepted it.

  Introduces a new top-level `me` command group for future account-level settings (profile, notification preferences, etc.).

- e10c47c: Add `aitcc workspace partner` to show the partner (billing/payout) registration state of the selected workspace.

  Endpoint: `GET /workspaces/:wid/partner` — returns `{registered, approvalType, rejectMessage, partner}`. A fresh workspace reports `registered: false, approvalType: 'DRAFT', partner: null`; once the owner registers the billing entity the `partner` record is populated (passed through opaquely until a live example is observed).

  Flag: `--workspace <id>` to inspect a workspace other than the current selection.

- 952d89a: Add `aitcc workspace segments ls [--category <cat>] [--search <text>] [--page N] [--workspace <id>]` to list user segments defined in the workspace (the 세그먼트 menu).

  Endpoint: `GET /workspaces/:wid/segments/list?category&search&page` — workspace-scoped (not per mini-app). Response: `{contents, totalPage, currentPage}`. `--category` defaults to "생성된 세그먼트" (the UI's initial tab). Per-segment record shape is passed through opaquely until a populated response is observed.

- c51816a: Add `aitcc workspace terms [--type TYPE] [--workspace <id>]` to show the console terms-of-agreement buckets that gate workspace-level features.

  Endpoint: `GET /workspaces/:wid/console-workspace-terms/:type/skip-permission` — one call per bucket. Five types: `TOSS_LOGIN`, `BIZ_WORKSPACE`, `TOSS_PROMOTION_MONEY`, `IAA`, `IAP`. Default is to query every bucket in parallel; `--type <TYPE>` limits to a single one. Each entry is `{required, termsId, revisionId, title, contentsUrl, actionType, isAgreed, isOneTimeConsent}` — useful for checking which features are blocked by pending agreements before running commands that depend on them (e.g. `app share-rewards` needs `TOSS_PROMOTION_MONEY`, `app promotions` creation needs partner+promotion-money, etc.).

## 0.1.11

### Patch Changes

- 1196c3e: Add `aitcc app bundles ls <id>` and `aitcc app bundles deployed <id>` to inspect upload bundles.

  Endpoints:

  - `GET /workspaces/:wid/mini-app/:aid/bundles[?page=&tested=&deployStatus=]` — page-based pagination, `{contents, totalPage, currentPage}`
  - `GET /workspaces/:wid/mini-app/:aid/bundles/deployed` — returns the single currently-deployed bundle (or `null`)

  `bundles ls` flags: `--page N`, `--tested true|false`, `--deploy-status STR` (e.g. `DEPLOYED`), plus `--workspace`, `--json`. `bundles deployed` only takes `--workspace` and `--json`.

  These are the read half of the deploy surface; `aitcc deploy` (task #24) will write new bundles through a separate upload endpoint once observed. For now `app bundles ls` lets the CLI and agent-plugin see what's already there, and `app bundles deployed` answers "what version is live?" for a given app — the quickest way to confirm a deploy from the terminal.

- 265dfb0: Add `aitcc app certs ls <id>` to list mTLS certificates issued for a mini-app.

  Endpoint: `GET /workspaces/:wid/mini-app/:aid/certs` — a simple array. Empty `[]` is the common case (no certs provisioned); per-record shape is passed through opaquely until a populated response is observed.

  Scaffolded under a `certs` group so follow-ups (`certs create`, `certs revoke`) land as sibling subcommands without reshuffling the command tree.

- 2ed6f7a: Add `aitcc app metrics <id>` to read conversion metrics for a mini-app.

  Endpoint: `GET /workspaces/:wid/mini-app/:aid/conversion-metrics?refresh=&timeUnitType=DAY|WEEK|MONTH&startDate=&endDate=`. Defaults to the last 30 days (host local) at DAY granularity.

  Flags: `--time-unit DAY|WEEK|MONTH`, `--start YYYY-MM-DD`, `--end YYYY-MM-DD`, `--refresh` (bypass server cache). Validates the date range locally (exit 2 with `invalid-date` if `start > end`).

  PREPARE-state apps return `metrics: []` with a `cacheTime` ISO timestamp; per-record shape is passed through opaquely until a live-traffic response is observed.

- a54cf8b: Add `aitcc app ratings <id>` to list user ratings and reviews for a submitted mini-app.

  The console UI's "평점 및 리뷰" tab is powered by `GET /mini-app/:id/app-ratings?page&size&sortField&sortDirection`. The response envelope carries `{ratings, paging, averageRating, totalReviewCount}`, so the CLI surfaces all four directly: the rollup numbers in both human and JSON output, and the per-review records (score, nickname, content, timestamp) as a tab-separated table in human mode / opaque records in JSON.

  Flags:

  - `--page N` (0-indexed, default 0) and `--size N` (default 20) for pagination
  - `--sort-field CREATED_AT|SCORE` (default `CREATED_AT`) and `--sort-direction ASC|DESC` (default `DESC`) to match the fields the console UI emits
  - `--workspace <id>` falls through to the selected workspace

  JSON exit codes match the other `app` subcommands: `invalid-id` / `invalid-config` → exit 2, live API/network/auth failures follow the shared `api-error` / `network-error` / `authenticated: false` contract.

- 9b07f49: Add `aitcc app reports <id>` to list user-submitted reports (신고 내역) for a mini-app.

  Endpoint: `GET /workspaces/:wid/mini-apps/:aid/user-reports?pageSize=N[&cursor=...]`. Note the **plural** `mini-apps` in the path — same split-personality as `mini-apps/review-status`. Cursor-based pagination (unlike ratings, which is page-based): the server hands back `{reports, nextCursor, hasMore}` and the caller passes `--cursor` opaquely on the next call.

  Flags:

  - `--page-size N` (default 20)
  - `--cursor <str>` — opaque token from a previous response's `nextCursor`
  - `--workspace <id>` falls through to the selected workspace
  - `--json`

  JSON exit codes follow the shared `app` subcommand contract (invalid-id / invalid-config → exit 2, api-error / network-error / `authenticated: false` for live failures).

- a8dbf98: Add `aitcc app share-rewards ls <id>` to list share-reward promotions for a mini-app.

  Endpoint: `GET /workspaces/:wid/mini-app/:aid/share-rewards?search=` — a simple array. The console UI always sends `search=` (empty matches everything); the CLI mirrors that shape so the request is indistinguishable from the UI's XHR.

  Flag: `--search <text>` for a title-contains filter. Per-record shape is passed through opaquely until a populated response is observed.

- fa17ba7: Add `aitcc notices` — read Apps in Toss notices (공지사항) from the terminal.

  Subcommands:

  - `aitcc notices ls [--page N] [--size N] [--search STR]` — list notices with page-based pagination and optional title substring filter
  - `aitcc notices show <id>` — print a single notice (title, subtitle, category, publish time, full body) or JSON-dump it with `--json`
  - `aitcc notices categories` — list the 7 category buckets with their post counts

  Lives on a separate Toss service (`api-public.toss.im/api-public/v3/ipd-thor`) with a hard-coded `workspaceId=129` that's shared across every console user — there's no per-user notice bucket. Session cookies captured at login are domain-matched against `.toss.im` so they're sent automatically without any extra handshake.

  New API client module at `src/api/ipd-thor.ts` so later ipd-thor surfaces (post feedback, likes, series) have a place to live. Commands/`requireSession` helper factored out of `resolveWorkspaceContext` since notices don't need a workspace id.

## 0.1.10

### Patch Changes

- f8ca390: Add `aitcc app status <id>` to check the review state of a submitted mini-app, with `--watch` to poll until it flips.

  The console UI shows a "검토 중이에요" banner on every submitted app's meta page. That banner isn't a single API field — it's derived from four things on the `/mini-app/:id/with-draft` envelope: `approvalType`, `current`, `rejectedMessage`, and whether a `draft` exists. `aitcc app status` encodes that derivation once so callers get a stable state string instead of reimplementing the logic.

  States emitted:

  - `not-submitted` — app exists but has no `approvalType` (register never called in review mode)
  - `under-review` — submitted, not yet reviewed (this is the "검토 중" banner case)
  - `rejected` — `rejectedMessage` is set; the CLI surfaces the reason in human output
  - `approved` — the published `current` row exists, no in-flight draft
  - `approved-with-edits` — approved + the editor has unpublished changes
  - `unknown` — any `approvalType` we haven't observed yet (guards forward-compat)

  `--watch` polls (default 60s, clamped [30, 3600]) until the state leaves `under-review`. `--json` emits NDJSON one record per tick; human mode only prints on state changes.

## 0.1.9

### Patch Changes

- 13c4a8b: Add `aitcc app show <id>` to surface the full mini-app detail, including fields that only live in the draft view.

  `aitcc app ls` and `GET /mini-app/:id` (detail) both return the app's **current** view — the published record end users see. Until a mini-app has been reviewed and approved, `current` is empty for almost every field: no `detailDescription`, no `csEmail`, no `homePageUri`, no `images`, no `keywordList`. This is what made `aitcc app register` look buggy during dog-food (fields appeared lost). They were in the draft view all along — readable from `GET /mini-app/:id/with-draft`, which is what this new subcommand reads.

  Flags:

  - `--view draft` (default) — what the editor / `app register` just wrote. This is the useful view until the app is approved.
  - `--view current` — the published record. Returns `miniApp: null` in `--json` when the app isn't reviewed yet, so agent-plugin can tell "unreviewed" from "reviewed and empty" apart.
  - `--view merged` — current with draft overlaid on top (draft wins per field). Useful once both exist.

  Human output summarises title/slug/status/home/cs/logo/subtitle + image count + keywords + category path. `--json` returns the raw `miniApp` record.

  No server-mutating calls.

## 0.1.8

### Patch Changes

- 379b2db: Revert the 0.1.7 "flat payload + `categoryList: [{id}]`" change for `aitcc app register`; keep the new manifest validators.

  Further dog-food against workspace 3095 showed the 0.1.7 shape was a regression, not a fix. The original 0.1.6 shape (`{miniApp, impression}` wrapper + `impression.categoryIds: [number]` + `images[]` rows with `displayOrder`) is what the server actually accepts. The earlier "missing fields" signal was a read-side issue — `GET /mini-app/:id` returns only the published `current` view, so the fields we sent looked lost. `GET /mini-app/:id/with-draft` shows them all correctly persisted.

  The 0.1.7 payload (flat + `categoryList`) triggers HTTP 400 on the server, so 0.1.7 is effectively broken. 0.1.8 restores working submits.

  What is kept from 0.1.7: the two pre-flight manifest validators (`titleEn` may only contain English letters, digits, spaces, and colons; `description` ≤ 500 code points). Both mirror server rules surfaced during dog-food.

  `/mini-app/review` is genuinely a one-shot register+submit-for-review endpoint when the payload is complete — no separate update or review-trigger endpoint exists.

## 0.1.7

### Patch Changes

- 729ae69: Fix `aitcc app register` submit payload shape based on dog-food #23 findings.

  The inferred `{miniApp, impression}` wrapper silently dropped every nested
  field on the server side (confirmed by round-tripping through
  `GET /workspaces/:wid/mini-app`). Submit now sends a flat top-level
  document matching the persisted row shape, and the `impression` block
  uses `categoryList: [{id}]` instead of `categoryIds: [number]`.

  Also adds two manifest validations that mirror server rules surfaced by
  the dog-food: `titleEn` may contain only English letters, digits, spaces,
  and colons; `description` must be at most 500 code points.

  Follow-up (out of scope for this patch): the `/mini-app/review` endpoint
  returns `reviewState: null`, strongly suggesting it creates a skeleton
  app without triggering review. A separate `aitcc app review-request`
  command will drive the trigger endpoint once captured.

## 0.1.6

### Patch Changes

- 5bd67ed: Add `aitcc app register` for one-shot mini-app registration from a YAML/JSON manifest.

  The command reads a manifest (default `./aitcc.app.yaml` → `./aitcc.app.json`), validates each referenced PNG against the console's dimension rules, uploads the images to `/resource/:wid/upload`, and submits the combined create + review payload to `/workspaces/:wid/mini-app/review`. See CLAUDE.md → "App registration" for the manifest schema and the full `--json` contract.

  The submit payload shape is inferred from static bundle analysis and has **not** been observed on the wire yet — the first real submission (dog-food task #23) is expected to either confirm or minor-correct the transform in `src/commands/register-payload.ts` + `src/api/mini-apps.ts`. The manifest shape is stable regardless.

## 0.1.5

### Patch Changes

- 543ba37: Add `aitcc app ls` to list mini-apps in the selected workspace.

  - Fetches `/workspaces/:id/mini-app` and `/workspaces/:id/mini-apps/review-status` in parallel and joins them by app id, so each row surfaces both the app identity and its review state in one call.
  - Honours the workspace selection from `aitcc workspace use`; `--workspace <id>` overrides for one-off inspection.
  - `--json` emits `{ ok: true, workspaceId, hasPolicyViolation, apps: [...] }`. `hasPolicyViolation` is surfaced because it is the console's workspace-wide policy flag, not a per-app attribute.
  - Plain output is `appId<TAB>name<TAB>reviewState` — easy to pipe through `column -t` or `awk`. Unknown review states render as `-`; unnamed apps as `(unnamed)`.
  - Mini-app payload shape is not yet fully documented (our test workspaces have zero apps); the API client normalises `id`/`name` across a few spellings and stashes the rest under `extra`. Follow-up exploration will tighten this once `sdk-example` is registered as a real mini-app.

- 087cb53: Add `aitcc members ls` and `aitcc keys ls` for workspace member and API-key listing.

  - `aitcc members ls [--workspace <id>]` — list workspace members, with `bizUserNo`, `name`, `email`, `status`, `role`. The `bizUserNo` is the stable per-person identifier; future member-management commands will key off it.
  - `aitcc keys ls [--workspace <id>]` — list console API keys used for deploy automation. Empty lists include a stderr hint pointing users at the console UI's "발급받기" flow (issuing keys programmatically is a follow-up once we can observe the creation endpoint).
  - Both commands reuse the shared workspace-context resolver added to `_shared.ts`, so `--workspace` parsing, "no workspace selected", and auth/network/api error triage are identical across `app ls` / `members ls` / `keys ls`.
  - `parsePositiveInt` moved from `workspace.ts` to `_shared.ts` so every command can depend on it without importing through `workspace.ts`.
  - Internal: `app ls` migrates to the shared resolver (behaviour-neutral). `keys ls --json` surfaces `needsKey: true` when the key list is empty, so agent-plugin skills can bail early with a friendly message before attempting a deploy that would 401.
  - Internal: `resolveWorkspaceContext` now has unit tests covering the three failure branches (exit 10 on no session, exit 2 on invalid id, exit 2 on no selected workspace), pinning the agent-plugin JSON contract.

- 58dc6a7: Add a throttled update-check notice that tells users when a newer `aitcc` is available, without hammering GitHub's anonymous 60/hr rate-limit bucket.

  - At most one network call every 24 hours, cached at `$XDG_CACHE_HOME/aitcc/upgrade-check.json` (or `~/.cache/aitcc/upgrade-check.json`).
  - Failed checks still update the throttle window to prevent aggressive retries.
  - Conditional GET with the previous ETag — a 304 response consumes no rate-limit slot.
  - Fully opt-out via `AITCC_NO_UPDATE_CHECK=1`.
  - The notice is skipped when stdout is not a TTY or when `--json` is passed, so agent-plugin consumers never see a stray line.
  - Only runs during successful `aitcc whoami` invocations. `aitcc login` / `aitcc logout` / `aitcc upgrade` never trigger the background check.

- ca2e799: Add `aitcc workspace ls / use / show` for multi-tenant workspace management.

  The Apps in Toss console scopes almost every resource (mini-apps, members, API keys, configs) under a workspace; an account can belong to multiple workspaces, so CLI operations need an explicit workspace context. Session schema bumps from v1 to v2 to persist `currentWorkspaceId` — v1 files are still read transparently and upgraded in-memory, then rewritten on the next explicit write.

  - `aitcc workspace ls` — list workspaces the current account can access. Marks the selected one with `*`.
  - `aitcc workspace use <id>` — select a workspace. Validates the id against the account's actual workspace list before persisting, so a typo fails fast instead of producing confusing 403s from every downstream command.
  - `aitcc workspace show [--workspace <id>]` — dump the workspace detail (business registration / verification / review state). Pass `--workspace <id>` on `show` (and on future workspace-scoped commands) to override the persisted selection for one call without clobbering it.
  - `--json` is supported on every subcommand and follows the existing exit-code contract (`ok`, `authenticated`, `reason`). Invalid id input produces `{ ok: false, reason: 'invalid-id', message }` with exit `2`; a missing workspace selection on `show` produces `{ ok: false, reason: 'no-workspace-selected' }`.

## 0.1.4

### Patch Changes

- 01912f4: Rename the CLI to `aitcc`, replace the OAuth-callback login scaffold with a Chrome DevTools Protocol flow, and wire `whoami` to the live console API.

  ## Breaking: CLI renamed

  The executable is now `aitcc` (Apps in Toss Community Console). Shorter than the previous `ait-console`, matches the organization's short name, and leaves `ait-console` free in case the Toss team ever ships their own tool. The npm package name (`@ait-co/console-cli`) is unchanged.

  - Binary: `ait-console-<os>-<arch>[.exe]` → `aitcc-<os>-<arch>[.exe]`.
  - Session directory: `$XDG_CONFIG_HOME/ait-console/` → `$XDG_CONFIG_HOME/aitcc/`. Existing sessions read as "no session" — re-run `aitcc login` once.
  - Env vars: `AIT_CONSOLE_*` → `AITCC_*` (`AITCC_BROWSER`, `AITCC_OAUTH_URL`, `AITCC_VERSION` build-time define, `AITCC_INSTALL_DIR`, `AITCC_QUIET`).

  Binary users: re-run `install.sh` to pick up the renamed asset. The installer does not touch the old `ait-console` binary — delete `$HOME/.local/bin/ait-console` (or wherever you installed it) manually once you've confirmed `aitcc` works. npm users: reinstall the package so the new `bin` entry lands in your `$PATH`.

  ## `aitcc login` now captures cookies via CDP

  The old flow waited for an OAuth callback on `127.0.0.1` — which never worked because the registered redirect on the public client_id is the production domain, not localhost. The new flow launches the user's system Chrome/Edge/Chromium in an isolated temporary profile, navigates to the Apps in Toss sign-in URL, and captures the session cookies (including `HttpOnly`) over CDP once the browser reaches the post-login workspace page. No OAuth redirect URI configuration is required.

  ## `aitcc whoami` is live by default

  `whoami` now calls the console's `members/me/user-info` endpoint, printing your name, email, role, and workspace list. Pass `--offline` to read only the cached identity. Exit codes: 0 on success, 10 when the session is missing or expired, 11 on network failure, 17 on other API errors.

  ## Removed

  The `oauth.ts` callback server, `--no-browser` flag, and `AIT_CONSOLE_OAUTH_CLIENT_ID` / `AIT_CONSOLE_OAUTH_SCOPE` env overrides are gone. Override the authorize URL with `AITCC_OAUTH_URL` and the browser executable with `AITCC_BROWSER` if needed.

## 0.1.3

### Patch Changes

- 92f3b51: Update README's pre-release banner to reflect that 0.1.x is now published to
  npm + GitHub Releases. The previous "Work in Progress — not yet published"
  note was inaccurate after the 0.1.0 ship; replace with a note that names the
  currently-shipped commands and points to TODO.md for what's next.

## 0.1.2

### Patch Changes

- 055c94b: Use `rcodesign` (apple-platform-rs) instead of Apple's stock `codesign` to
  ad-hoc sign macOS binaries during the release build. Bun-compiled binaries
  have a malformed `LC_CODE_SIGNATURE` stub that stock `codesign` rejects
  (`invalid or unsupported format for signature`); rcodesign handles them after
  a `codesign --remove-signature` pass strips the broken stub. The
  release-binaries workflow downloads the rcodesign 0.29.0 prebuilt for the
  macOS runner, so no Cargo/Rust toolchain is needed at CI time. Once Bun
  1.3.13+ stable lands (the upstream fix is merged in canary), this whole path
  can be replaced with the stock `codesign` invocation again.

## 0.1.1

### Patch Changes

- 4264e0c: Apply ad-hoc code signature to macOS binaries during the release build so users
  can run `ait-console` on Sonoma+ without hitting Gatekeeper SIGKILL on first
  launch. Adds `scripts/macos-entitlements.plist` (JIT / unsigned-executable-memory
  / disable-library-validation, required by Bun's compiled binary at runtime) and
  makes `scripts/build-bin.ts` invoke `codesign --force --sign -` for any
  `bun-darwin-*` target when running on a macOS host. `install.sh` now also strips
  `com.apple.quarantine` and re-applies an ad-hoc signature on Darwin as a safety
  net. Proper notarization is still deferred to 1.0.

## 0.1.0

### Minor Changes

- 4eb4e9f: Initial 0.1.0 release of `ait-console`.

  **CLI surface** (MVP):

  - `ait-console whoami` — reads local session, reports logged-in user. `--json` for machine output.
  - `ait-console login` — localhost callback OAuth scaffold (random `state`, 5-min timeout, XDG `session.json` with `0600` perms). Actual Toss OAuth endpoint pending discovery; override via `AIT_CONSOLE_OAUTH_URL` env var.
  - `ait-console logout` — idempotent session file removal.
  - `ait-console upgrade` — downloads matching platform binary from the latest GitHub Release and atomically replaces itself.
  - `--json` supported on every command; stderr for diagnostics, stdout for structured result.

  **Build pipeline**:

  - Node dist via `tsdown` for npm install.
  - Platform-specific binaries via `bun build --compile` for Linux/macOS × x64/arm64, Windows × x64. Attached to each GitHub Release with `SHA256SUMS`.
  - `install.sh` at repo root detects OS/arch, verifies checksum, installs to `$HOME/.local/bin`.

  **Session storage**: XDG `session.json` with `0600` perms (keychain deferred per CLAUDE.md rationale).
