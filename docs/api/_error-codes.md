# Error code 카탈로그

콘솔 API의 `error.errorCode` 값(envelope: `{resultType: 'FAIL', error: { reason, errorCode, ... }}`)과 콘솔 SPA가 분기에 사용하는 HTTP status 정책을 모은 reference. **단일 source of truth는 아니다** — 자세히는 아래 "방법론과 한계" 참조.

## 방법론과 한계

이 카탈로그는 두 갈래에서 모았다.

1. **콘솔 SPA bundle 정적 분석** — `https://apps-in-toss.toss.im/console/`의 `bootstrap.<hash>.js`(brotli 해제 후 약 1.4 MB)를 grep해 enum 상수와 분기 로직을 추출. SPA가 client-side에서 명시적으로 알고 있는 코드만 잡힌다.
2. **dog-food 시 관측한 서버 응답** — `mini-apps.md` 같은 도메인 파일에 캡처된 실제 `error.errorCode`/`error.reason` 페어.

**중요한 negative finding**: 콘솔 SPA에는 **`errorCode → 사용자 메시지` 매핑 dictionary가 없다.** 화면에 뜨는 한국어 문구는 거의 모두 서버의 `error.reason` 필드를 그대로 표시하는 것이다. 따라서:

- **이 카탈로그는 "관찰된 코드 모음"이지 "콘솔 API가 반환하는 모든 errorCode 목록"이 아니다.** 새 endpoint를 dog-food하다가 처음 보는 코드를 만나면 그 도메인 파일에 캡처를 남기고 여기 표에 추가한다.
- 사용자에게 보여줄 메시지를 client에서 hardcoding할 일은 거의 없다. 서버 reason을 그대로 띄우는 것이 콘솔과 일치하는 동작.
- Schema validator(`g1(Vi())`)가 `errorCode`를 **nullable string**으로 정의해 둔 것도 같은 맥락 — 서버는 임의 코드를 보낼 수 있고, 일부 응답은 코드가 아예 없다.

## 알려진 코드

### Auth / 약관 family

콘솔 SPA가 client에서 직접 분기에 쓰는 코드. bundle의 `Li` enum + `MR` redirect handler + `TR` whitelist에서 확인됨. Whitelist에 든 코드는 모든 endpoint에서 fail이 떠도 **자동으로 약관 페이지로 리다이렉트되며 throw되지 않는다** — CLI는 이런 자동 redirect 동작을 흉내내지 않으므로 그냥 `errorCode`를 그대로 surface하면 된다.

| code | enum 이름 | 의미 (콘솔 SPA 동작) |
|---|---|---|
| `4032` | `앱인토스_미가입` | 앱인토스 콘솔 가입 자체가 안 된 상태. SPA는 `/console-sign-up`으로 redirect. |
| `4036` | `유저_약관_미동의` | 사용자 개인 약관 미동의. SPA는 `/user-terms`로 redirect. |
| `4037` | `토스로그인_약관_미동의` | 토스 로그인(OIDC) 약관 미동의. SPA는 `/workspace/<wid>/toss-login-terms?miniAppId=<id>`로 redirect (workspace context 필요). |
| `4039` | `프로모션_머니_약관_미동의` | 프로모션 머니 기능 약관 미동의. SPA에 명시적 redirect 케이스 없음(공통 throw). |
| `4040` | `워크스페이스_약관_미동의` | 워크스페이스 단위 약관 미동의. SPA는 `/workspace/<wid>/workspace-terms`로 redirect. |
| `4099` | `광고관리_약관_미동의` | 광고 관리 기능 약관 미동의. SPA에 명시적 redirect 케이스 없음. |
| `5001` | `인앱결제상품_약관_미동의` | 인앱결제 상품 약관 미동의. SPA에 명시적 redirect 케이스 없음. |
| `5002` | (미확인 — 서버 `reason` message-only) | **거래처(파트너) 미등록.** 약관 동의가 아니라 워크스페이스 파트너(빌링/정산 주체) 등록 여부 게이트 — 5001(약관)과는 별개 축이다. IAP 상품/주문/환불 조회가 전부 이 코드로 막힌다. 실측: `GET .../in-app-purchase/catalogs`가 `errorCode: "5002", reason: "거래처 등록이 필요합니다."`로 FAIL (2026-07-23, workspace 3095, 미등록 상태). SPA에 명시적 redirect 케이스 없음. CLI는 `aitcc workspace partner`로 상태 확인을 안내(`src/commands/_shared.ts#hintForErrorCode`가 5002 에러에 이 hint를 붙인다). 상세: [`in-app-purchase.md`](./in-app-purchase.md). |
| `5010` | `혁신금융서비스_약관_미동의` | AI 위험 고지·이용약관(`AI_RISK_USE`) 미동의. **계정-level 최상위 게이트** — 미동의 시 거의 모든 워크스페이스 read/write가 막힌다(Deploy Key 발급·배포 포함). SPA는 `/ai-risk-use-terms`로 redirect. CLI는 `aitcc me terms agree --scope AI_RISK_USE`로 동의 처리(`src/commands/_shared.ts#hintForErrorCode`가 5010 에러에 이 hint를 붙인다). 엔드포인트: [`auth-session.md`](./auth-session.md) "`?termsScope=AI_RISK_USE`". |

CLI는 이 코드들을 만나면 별도 redirect 자동화 없이 사용자에게 `aitcc me terms` 같은 명령으로 콘솔에서 동의를 받도록 안내해야 한다. 4040(워크스페이스 약관)은 `aitcc workspace terms`에, 5002(거래처 미등록)는 `aitcc workspace partner`에, 5010(AI 위험 고지)은 `aitcc me terms agree --scope AI_RISK_USE`에 이미 포커스됨 — 5002/5010 모두 `hintForErrorCode`가 자동으로 seam hint를 emit한다.

### 세션 / 권한

| code | 의미 |
|---|---|
| `4010` | 인증 만료/없음. HTTP 401과 동치. CLI: `TossApiError.isAuthError === true` → `aitcc login` 재실행 유도. [`src/api/http.ts`](../../src/api/http.ts) 참조. |
| `500` | 권한 부족(서버측). HTTP 500이 아니라 envelope의 `errorCode: '500'`인 경우가 있다 — 응답 시간이 빠른데 코드만 500이 떨어지면 timeout이 아니라 의도적 거부일 수 있음. mini-app DELETE 케이스에서 관측됨 ([`mini-apps.md`](./mini-apps.md) "DELETE permissions"). **다른 계열과 혼동 주의**: `GET /workspaces/<wid>/business-verification/license/data`도 숫자 `500`을 쓰지만 이건 transport-level FAIL envelope이 아니라 **SUCCESS envelope 안에 nest된 business-level 필드**(`{errorCode: 500}` = 사업자 라이선스 미등록)다 — 이 표의 다른 항목들과 도착 경로 자체가 다르니 같은 코드로 뭉뚱그리지 말 것. 상세: [`workspaces.md`](./workspaces.md) "business-verification". |

### Validation

| code | 의미 |
|---|---|
| `4000` | "잘못된 요청입니다" — 서버측 validation 실패 (charset, length, 누락 필드, dimension 등). `error.reason`이 한국어 사유. 콘솔에서 폼이 reject되는 거의 모든 경우. [`mini-apps.md`](./mini-apps.md) "Server-side validation" 표에 알려진 trigger 정리. |
| `null` | `errorCode`가 비어 있고 `reason`만 있는 경우. 예: `categoryIds`에 leaf-level id를 넣었을 때 `reason: "카테고리 정보가 없음: <id>"`. Schema가 nullable이라는 사실의 산 증거. |

### 도메인 lock

| code | 의미 |
|---|---|
| `4046` | "검수중인 요청이 있어 검수요청을 할 수 없어요" — `approvalType: REVIEW` 상태에서 `POST /mini-app/review` 재호출 시. 운영팀이 검수 결과(APPROVED/REJECTED)를 내야 잠금 해제. mini-app review-withdraw endpoint 부재로 사용자가 직접 큐에서 빼는 방법 없음. 상세는 [`mini-apps.md`](./mini-apps.md) "REVIEW lock". |

### KYC

bundle에 `Zpe` enum과 `KycHighRiskGroupError` 클래스로 살아있다. 개인 KYC가 고위험군으로 분류된 경우 SPA가 일반 `Error` 대신 전용 클래스로 throw해 별도 화면을 띄우는 용도. 일반 콘솔 API 응답에서는 거의 보이지 않는다.

| code | 의미 |
|---|---|
| `5000` | KYC 고위험군 사업자(`Zpe.고위험군사업자`). SPA는 `KycHighRiskGroupError`로 wrapping. |

## Prefix-form errorCodes (`<domain>.<Reason>`)

`errorCode`가 항상 숫자 문자열인 것은 아니다. 일부 도메인은 `<camelCaseDomain>.<PascalCaseReason>` 형태(domain-tagged) 코드도 함께 emit한다. envelope shape은 같다 — `error.errorCode`가 `"miniApp.InvalidTitle"` 같은 dotted string으로 와도 `error.reason`은 평소처럼 한국어 문구다.

dog-food 중 sdk-example#39 등록 (2026-05-03) 시 처음 관찰됐고, 콘솔 SPA bundle에는 numeric enum과 별도로 이 prefix 형태가 카테고리별로 흩어져 있다 (bundle 정적 분석에서 prefix가 numeric만큼 깔끔하게 enum화돼 있지 않아 발견 시점마다 추가). 새 prefix 코드를 만나면 도메인 파일(`mini-apps.md` 등) 캡처와 함께 이 표에 한 줄 추가한다.

| errorCode | 도메인 | 의미 | 발생 endpoint | 사용자 액션 |
|---|---|---|---|---|
| `miniApp.InvalidTitle` | `miniApp` | `titleKo`가 길이/허용 문자 규칙 위반 (`^[가-힣A-Za-z0-9 :·?]+$`, 공백 제외 ≤ 10 code points). 콘솔 SPA가 form 입력 단계에서 cap을 걸어 두기 때문에 일반 사용자는 잘 못 만나지만, CLI/매니페스트는 입력 길이를 자동 제한하지 않으므로 직격당한다. | `POST /workspaces/:wid/mini-app/review` | `aitcc.yaml`의 `titleKo`를 ≤ 10 글자(공백 제외)로 줄이고 허용 문자만 남긴다. CLI의 `app-manifest.ts` preflight가 같은 규칙을 enforce — 통과 못 하면 그 메시지를 그대로 따른다. |
| `miniApp.InvalidTitleEn` | `miniApp` | `titleEn`이 길이/case/허용 문자 규칙 위반 (`^[A-Za-z0-9 :·?]+$`, 공백 제외 ≤ 15 code points, 단어별 title-case — 첫 글자만 uppercase + 나머지 lowercase, `AITC` 같은 all-caps 거부). 정규식 위반 시 reason은 "앱 영문 이름은 영어, 숫자, 공백, 콜론(:)만 사용 가능해요" 메시지가 함께 옴. | `POST /workspaces/:wid/mini-app/review` | `aitcc.yaml`의 `titleEn`을 위 규칙에 맞춰 수정 (예: `Aitc Sdk Example`). preflight는 `app-manifest.ts`의 `TITLE_EN_REGEX` + `isTitleCaseWord`. |

알려진 prefix 코드의 출처/캡처: [`docs/api/mini-apps.md`](./mini-apps.md) "Server-side validation" 섹션. CLI는 위 두 코드를 `src/api/error-messages.ts`에서 사용자 액션 한 줄로 매핑하고, **알려지지 않은** prefix 코드는 매핑 없이 코드를 그대로 surface한다(`(<errorCode>) <reason>`) — 추측해서 표에 채우지 않는 게 원칙.

## HTTP retry 정책 (transport-level)

콘솔 SPA의 fetch wrapper(`r6`/`AGe`/`Fle`)가 정의한 transport-level 재시도 정책. envelope의 `errorCode`가 아니라 raw HTTP status에 대한 동작이다.

| 상수 | 값 | 의미 |
|---|---|---|
| `AGe` | `[408, 413, 429, 500, 502, 503, 504]` | retry 대상 status whitelist. |
| `Fle` | `[413, 429, 503]` | `afterStatusCodes` — `Retry-After` 헤더를 존중해야 하는 subset. |
| `OGe` | `['get','put','head','delete','options','trace']` | retry 가능 method 화이트리스트 (POST/PATCH 비포함). |
| `r6.limit` | `2` | 재시도 횟수 상한. |

CLI(`src/api/http.ts`)는 현재 retry를 구현하지 않는다 — 매 명령이 보통 1~2개 호출이라 transparent retry 이득보다 디버깅 가시성이 더 중요. 추후 watch/poll 류 명령(`app status --watch` 등)을 추가하면 같은 정책을 따르는 게 자연스럽다.

HTTP 504는 SPA가 추가로 `NetworkTimeoutError`로 wrap해 메시지를 "네트워크 타임아웃 오류가 발생하였습니다."로 바꾼다. CLI는 status 그대로 노출하면 충분.

## 코드 추가 절차

새 코드를 dog-food나 콘솔 관찰 중에 만나면:

1. 응답 envelope 캡처(`{resultType, error: {reason, errorCode, data?}}`) — redaction 정책 [`_redaction.md`](./_redaction.md) 적용.
2. 해당 도메인 파일(`mini-apps.md`, `notices.md` 등)에 endpoint 컨텍스트와 함께 추가.
3. 이 파일의 알맞은 섹션에 한 줄 — 코드 / 짧은 의미 / 도메인 파일 링크.
4. SPA bundle에서 enum이나 분기 로직이 잡히면 별도로 명시(이 카탈로그의 "방법론과 한계" 1번에 해당하는 정보).
