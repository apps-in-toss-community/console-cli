# In-app purchase (IAP)

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

미니앱의 인앱결제 상품 카탈로그·주문·환불 조회 + 상품 등록 endpoint 묶음. 워크스페이스 파트너(빌링/정산 주체) 등록 여부는 별도 도메인([`workspaces.md`](./workspaces.md) "partner")이 다루지만, IAP의 거의 모든 endpoint가 그 등록 여부에 게이트돼 있어(`errorCode: 5002`) 두 문서를 함께 봐야 한다.

> **Capture status note**: endpoint 경로 자체는 콘솔 SPA의 route 등록 테이블(`M(D.path("...").method("get"|"post"|"put").create())`)에서 직접 읽어 확정했다 — 22개 in-app-purchase 하위 endpoint 전수를 정적 분석으로 나열([issue #220](https://github.com/apps-in-toss-community/console-cli/issues/220) "정적 분석 inventory"). 다만 이 워크스페이스(3095)가 아직 파트너 미등록 상태라 `catalogs`(목록)를 포함한 거의 모든 GET이 `errorCode: 5002`로 막히고, 실제 SUCCESS 응답 shape은 미관측이다. 예외는 `products create`의 request body — 콘솔 SPA의 공유 `IAPProductEditor` 폼 컴포넌트를 정적 분석해 필드명·검증 규칙을 복원했고, [issue #232](https://github.com/apps-in-toss-community/console-cli/issues/232) (2026-07-25) 재측정으로 discount policy 서브구조까지 포함해 high confidence로 확정했다(아래 "products create — confirmed body shape"). 파트너 등록 후 재관측이 필요한 항목은 각 섹션에 명시.

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-purchase/catalogs` | 상품 목록 | ⚠️ (5002 게이트만 ✅) |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-purchase/catalog/<product_id>` | 상품 상세 | ⚠️ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-purchase/orders` | 주문 목록 | ⚠️ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-purchase/refunds` | 환불 목록 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-purchase/product/inspection` | 상품 등록 + 검수 제출 (원샷) | ✅ (body shape — request 자체는 미실행) |

**Out of scope 항목** (issue #220 명시 — 정적 분석으로 경로만 확보, 이 문서에선 인벤토리만 유지하고 명령/문서 상세화 안 함):

| Method | Path | 용도 |
|---|---|---|
| PUT | `.../in-app-purchase/catalog/<product_id>/status/<status>` | 상품 활성/비활성 전환 |
| PUT | `.../in-app-purchase/product/<product_id>/inspection` | 상품 수정 + 재검수 제출 |
| POST | `.../in-app-purchase/product/inspection/<inspection_id>/recall` | 검수 대기 취소 |
| GET | `.../in-app-purchase/product/<product_id>/discount-history` | 할인 이력 |
| POST | `.../in-app-purchase/discount`, `GET .../discount/<policy_id>`, `POST .../discount/<policy_id>/terminate`, `GET .../discount/<policy_id>/performance` | 할인 정책 CRUD |
| GET/POST | `.../in-app-purchase/subscription-webhook`, `POST .../subscription-webhook/test` | 구독 갱신 알림 웹훅 |
| POST | `.../in-app-purchase/refunds/<order_id>/approve`, `/reject` | 환불 승인/거절 |
| POST | `.../in-app-purchase/performance/revenue`, `/funnel` | 성과 대시보드 |
| GET | `/workspaces/<wid>/in-app-purchase/settlement/monthly-summary` | 워크스페이스 레벨 정산 요약 |
| GET | `/api-public/v3/appsintossconsole/in-app-purchase/product/calculate-gross-price` | 판매가 계산기 (workspace/앱 무관, 유틸리티성) |

## `GET .../in-app-purchase/catalogs` — 상품 목록

- **Used by**: [`src/api/in-app-purchase.ts#fetchIapProducts`](../../src/api/in-app-purchase.ts), `aitcc app iap products ls`
- **Capture status**: ⚠️ mixed — 5002 에러 경로는 ✅ confirmed, SUCCESS 응답 shape은 미관측
- **Query**: `?page=<int>&search=<string>&type=<CONSUMABLE|NON_CONSUMABLE|SUBSCRIPTION>&catalogStatus=<string>` (콘솔 UI의 다중 선택 필터 — `type`/`catalogStatus`는 반복 가능한 query param으로 추정, 실측 없음)

### 실측: 파트너 미등록 시 5002 (2026-07-23, workspace 3095 / app 31146)

```json
{
  "resultType": "FAIL",
  "success": null,
  "error": {
    "errorType": 1,
    "errorCode": "5002",
    "reason": "거래처 등록이 필요합니다."
  }
}
```

CLI는 `hintForErrorCode('5002')`([`src/commands/_shared.ts`](../../src/commands/_shared.ts))로 이 코드를 만나면 `--json` 여부와 무관하게 `아itcc workspace partner`로 상태를 확인하라는 hint를 구조화된 형태로 붙인다. 상세는 [`_error-codes.md`](./_error-codes.md) `5002` 항목.

### SUCCESS 응답 (⚠️ 추정)

파트너 등록 후 재관측 필요. 이 API 계열의 다른 목록 endpoint(`bundles`, `segments` 등)가 전부 page-based `{contents, totalPage, currentPage}` shape을 쓰므로 같은 shape으로 추정해 뒀다:

```jsonc
{
  "resultType": "SUCCESS",
  "success": { "contents": [ /* 상품 요약 배열 — 필드는 아래 "상품 상세" 참조 */ ], "totalPage": 0, "currentPage": 0 }
}
```

## `GET .../in-app-purchase/catalog/<product_id>` — 상품 상세

- **Used by**: [`src/api/in-app-purchase.ts#fetchIapProduct`](../../src/api/in-app-purchase.ts), `aitcc app iap products show <productId>`
- **Capture status**: ⚠️ inferred — 이 워크스페이스의 모든 호출이 `catalogs`와 동일하게 5002로 막혀 실제 응답을 받은 적이 없다.
- 필드명은 상품 수정 페이지의 역-매퍼(`index.ClMdTz7O.js`의 함수 `U`, edit-mode `defaultValues` 조립부)에서 역추적:

```ts
// U(e) — GET 응답 e를 상품 수정 폼의 defaultValues로 변환
{
  productId: string,
  productName: string,
  description: string,
  netPrice: number,              // "공급가" — products create의 `price`와 같은 개념, 필드명만 다름
  productType: 'CONSUMABLE' | 'NON_CONSUMABLE' | 'SUBSCRIPTION',
  iconImgUrl: string,
  minAppDeployment?: { deploymentId: number, versionName: string },
  renewalCycle?: 'WEEKLY' | 'MONTHLY' | 'YEARLY',
  discountPolicies: Array<{ discountType: 'FREE_TRIAL' | 'NEW_SUBSCRIPTION' | 'RETURNING', ...}>,
  catalogStatus: 'NOT_REGISTERED_YET' | 'ACTIVE' | 'INACTIVE',
  currentInspection?: { id: string, status: 'IN_PROGRESS' | 'REJECTED' | 'CANCELLED' | string },
  discount?: { status: string, targetSegment: string, discountedPrice: number, startAt: string, endAt: string },
}
```

CLI는 이 shape을 강제하지 않고 응답을 그대로(opaque) 통과시킨다 — 라이브 캡처가 없는 상태에서 필드 하나라도 틀리게 타입을 좁히면 실제 값이 왔을 때 오히려 조용히 깨질 수 있다.

## `GET .../in-app-purchase/orders` / `.../refunds` — 주문/환불 목록

- **Used by**: [`src/api/in-app-purchase.ts#fetchIapOrders`](../../src/api/in-app-purchase.ts) / `#fetchIapRefunds`, `aitcc app iap orders ls` / `aitcc app iap refunds ls`
- **Capture status**: ❌ not captured — 경로만 정적 분석으로 확인. 콘솔 SPA의 호출부가 params 객체를 그대로 전달하는 형태라 `page` 이외의 query param 이름을 정적 분석으로 복원하지 못했다.
- CLI는 `page`만 지원하는 얇은 wrapper로 구현했다(`{contents, totalPage, currentPage}` shape 추정, `bundles`/`catalogs`와 동일 관례). 실제 필터 파라미터·응답 필드는 라이브 캡처 시 보강.

## `POST .../in-app-purchase/product/inspection` — 상품 등록 + 검수 제출 (원샷)

- **Used by**: [`src/api/in-app-purchase.ts#createIapProduct`](../../src/api/in-app-purchase.ts), `aitcc app iap products create`
- **Capture status**: ✅ body shape confirmed — 콘솔 SPA 직렬화 로직 정적 분석 + 재측정([issue #232](https://github.com/apps-in-toss-community/console-cli/issues/232), 2026-07-25, high confidence). **응답은 물론 request 자체도 라이브로 호출된 적이 없다** — 이건 "계약은 확정, 라이브 미실행" 상태다(SECRET-HANDLING: read-only가 아니라 실제 상품을 등록하고 검수 큐에 올리는 mutation이라, 메인테이너 승인 게이트(`--confirm`) 뒤에서만 실행된다).
- 미니앱 등록(`POST /mini-app/review`, [`mini-apps.md`](./mini-apps.md) "Update mode")과 같은 패턴 — **등록과 검수 제출이 분리된 두 endpoint가 아니라 단일 POST**. dual-mode(create vs update)는 이 endpoint가 아니라 `PUT .../product/<productId>/inspection`(수정)으로 나뉘어 있다는 점만 미니앱과 다르다.
- **게이트: 광고 지면 생성(`app ads placement-groups create`)보다 강하다.** ⚠️ 승인 전(사전-승인) create는 광고와 달리 **막힐 개연성이 높다** — (1) `minDeploymentId`는 **APPROVED 상태 배포에서만** 유효한데 dog-food 앱 31146은 아직 승인된 배포가 0개, (2) create = 심사 제출이라 IAP 위탁매매 약관(`errorCode: 5001`) 미동의 시 서버가 거부할 개연성이 있다. 그래서 `aitcc app iap products create`는 실제 POST 전에 **read-only preflight**로 `catalogs`를 먼저 호출해, 그 GET이 5001로 실패하면 POST를 시도하지도 않고 `aitcc workspace terms --type IAP`를 가리키는 힌트로 중단한다(`hintForErrorCode('5001')`, [`_error-codes.md`](./_error-codes.md) `5001` 참고 — 이 워크스페이스(3095)는 실제로 이 약관이 미동의 상태다, [`mini-app-bundles.md`](./mini-app-bundles.md)의 `app deploy --dry-run` terms-blocker 캡처에서 확인). 약관 동의는 법적 결정이라 CLI가 대신 처리하지 않는다.

### products create — confirmed body shape

콘솔 SPA의 상품 등록/수정 공용 폼 컴포넌트 `IAPProductEditor`(`IAPProductEditor.BQeOKeLb.js`)의 `handleSubmit` 조립부와, 등록 페이지 wrapper(`index.C6av4Lke.js`)를 추적해 복원:

```ts
// IAPProductEditor의 handleSubmit(R => onSubmit({...R, discountPolicies, currency, defaultLocale}))
// 등록 페이지의 onSubmit(u => POST(".../product/inspection", {...u, workspaceId, miniAppId}))
{
  type: 'CONSUMABLE' | 'NON_CONSUMABLE' | 'SUBSCRIPTION',
  name: string,                 // <=30 chars (공백 포함), react-hook-form validate: `length>30`
  description: string,          // <=45 chars, validate: `length>45`
  price: number,                // 400..1,400,000 KRW, 10원 단위 스냅 — "공급가", GET 응답의 `netPrice`와 동일 개념
  iconImgUrl: string,            // 이미 업로드된 이미지 URL (별도 업로드 endpoint 필요 — 미확인, follow-up)
  minDeploymentId: number,       // 최소 지원 번들 deploymentId — APPROVED 상태 배포만 유효 (서버 hard precondition)
  postInspectionStatus: 'ACTIVE' | 'INACTIVE',  // 검수 통과 후 즉시노출(ACTIVE) 여부, 기본 INACTIVE
  renewalCycle?: 'WEEKLY' | 'MONTHLY' | 'YEARLY',  // type===SUBSCRIPTION일 때만 필수, 그 외 거부
  discountPolicies: Array<{...}>,  // type===SUBSCRIPTION이 아니면 항상 []
  currency: 'KRW',               // 폼이 하드코딩 (`Ve="KRW"`)
  defaultLocale: 'KO_KR',        // 폼이 하드코딩 (`_e="KO_KR"`)
}
```

`workspaceId`/`miniAppId`는 path param이고 body엔 들어가지 않는다.

**CLI 플래그 매핑**: `--type` `--name` `--description` `--price` `--icon`(→`iconImgUrl`) `--min-deployment`(→`minDeploymentId`) `--expose`(불리언, true면 `postInspectionStatus: ACTIVE`, 기본 false→`INACTIVE`) `--renewal-cycle` `--discount`. `--price`는 400~1,400,000 범위 검증을 **10원 단위로 스냅한 뒤의 값**에 대해 수행하고, 원래 입력이 10원 단위가 아니면 stderr(비-json) 또는 `warnings`(json)로 경고한다. `--renewal-cycle`/`--discount`는 `--type SUBSCRIPTION`이 아니면 값이 와도 조용히 버리지 않고 **거부**한다(issue #232 "type-conditional fields... fail fast").

**`--discount` spec 포맷**: 이 repo가 고정한 citty 0.2.2는 반복 플래그를 배열로 모으는 `multiple` 옵션이 없다(node:util `parseArgs`를 `strict:false`로 감싸기만 하고 `multiple`을 설정하지 않음 — 직접 확인: 같은 문자열 플래그를 두 번 주면 마지막 값만 남는다). 그래서 "repeatable"의 실용적 대체로 **`;`-구분 다중 entry를 담는 단일 `--discount` 플래그**를 쓴다(entry 내부는 `,`-구분 `key=value` — `products ls`의 `--type`/`--catalog-status`가 쓰는 `splitCommaList` 관례의 확장):

```
--discount "type=FREE_TRIAL,period=ONE_WEEK"
--discount "type=FREE_TRIAL,period=ONE_WEEK;type=RETURNING,durationMonths=1,discountedNetPrice=2000"
```

`type`은 `FREE_TRIAL`(→`period`: `THREE_DAYS`\|`ONE_WEEK`\|`TWO_WEEKS`\|`ONE_MONTH`) 또는 `NEW_SUBSCRIPTION`/`RETURNING`(→`durationMonths`≤12 + `discountedNetPrice`)이고, entry당 type 하나(콘솔 UI가 3개 고정 슬롯 체크박스라 중복 거부), 미확인 키는 거부. 구현·테스트는 [`src/commands/app-iap.ts#parseDiscountPoliciesSpec`](../../src/commands/app-iap.ts).

**`--min-deployment` APPROVED 검증은 client-side 미구현 (follow-up)**: 서버는 APPROVED 상태 배포만 유효한 `minDeploymentId`로 받는데, 이걸 client에서 미리 검증하려면 `fetchBundles`(`GET .../bundles?deployStatus=...`)의 불투명한 필터 값·응답 필드명을 추측해야 한다 — dog-food 앱 31146엔 APPROVED 배포가 아직 하나도 없어 실제 채워진 응답을 관측한 적이 없다. 검증되지 않은 추측을 배포하느니 CLI는 `--min-deployment`가 양의 정수인지만 확인하고, 승인되지 않은 값은 서버가 거부하도록 남겨둔다.

**CLI가 이 body에서 의도적으로 빼는 필드**: 폼은 `isAgreed`(체크박스 "위 내용을 확인했어요. 설정된 내용으로 상품을 등록할게요.")도 react-hook-form 필드로 등록돼 있어, `handleSubmit`의 스프레드(`{...R, ...}`)에 구조적으로 포함될 수 있다 — 다만 이게 실제로 서버 request body에 실려 전송되는지, 서버가 이를 검증하는지는 미확인이다(등록 마법사의 법정 동의 체크박스들이 서버 payload엔 안 실리는 것과 같은 패턴일 가능성이 높음 — [`mini-apps.md`](./mini-apps.md) "Server-side validation" 참고). CLI는 이 필드를 body에 넣지 않는 대신, 동일한 의도를 `--confirm` CLI-level 게이트로 강제한다(`aitcc app iap products create`는 `--dry-run` 없이 `--confirm` 없으면 거부, exit 2). 실제로 서버가 `isAgreed`를 요구한다면 첫 라이브 시도에서 명확한 validation 에러로 드러날 것이고, 그때 이 문서와 body 조립 로직을 보강한다.

**REVIEW-lock(미확인)**: 미니앱 등록의 `errorCode: 4046`(검수중인 요청이 있어 재요청 불가, [`mini-apps.md`](./mini-apps.md) "REVIEW lock")과 같은 패턴이 IAP 심사에도 있을 수 있다 — 관측된 적은 없지만, 만약 뜬다면 운영팀이 기존 심사를 처리할 때까지 대기하는 게 맞는 대응이고 **새 상품을 만들어 우회하지 않는다**(umbrella CLAUDE.md §3의 "lock 풀려고 새 앱 만들기" 반-패턴과 동일 원칙).

**실행 정책**: `--dry-run`은 payload 조립·검증만 하고 네트워크 호출이 전혀 없다(preflight 포함 없음). `--confirm` 경로는 POST 전에 read-only `catalogs` preflight를 한 번 거친다(위 "게이트" 참고). 이 repo의 자동 테스트·dog-food 검증은 **mocked fetch로만** `createIapProduct`를 호출한다 — 실제 콘솔에 대한 첫 호출은 메인테이너가 명시적으로 `--confirm`을 붙여 실행하는 시점까지, 그리고 위 두 precondition이 충족된 뒤까지 일어나지 않는다.

## 짝 문서

- [`workspaces.md`](./workspaces.md) "partner" — IAP 전체를 게이트하는 거래처(파트너) 등록 상태.
- [`_error-codes.md`](./_error-codes.md) `5002` — 파트너 미등록 게이트 코드.
- [`mini-apps.md`](./mini-apps.md) "Update mode" — "등록+검수 제출 원샷" 패턴의 원조 사례(미니앱 등록).
