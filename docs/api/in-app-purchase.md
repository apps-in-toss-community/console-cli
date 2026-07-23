# In-app purchase (IAP)

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

미니앱의 인앱결제 상품 카탈로그·주문·환불 조회 + 상품 등록 endpoint 묶음. 워크스페이스 파트너(빌링/정산 주체) 등록 여부는 별도 도메인([`workspaces.md`](./workspaces.md) "partner")이 다루지만, IAP의 거의 모든 endpoint가 그 등록 여부에 게이트돼 있어(`errorCode: 5002`) 두 문서를 함께 봐야 한다.

> **Capture status note**: endpoint 경로 자체는 콘솔 SPA의 route 등록 테이블(`M(D.path("...").method("get"|"post"|"put").create())`)에서 직접 읽어 확정했다 — 22개 in-app-purchase 하위 endpoint 전수를 정적 분석으로 나열([issue #220](https://github.com/apps-in-toss-community/console-cli/issues/220) "정적 분석 inventory"). 다만 이 워크스페이스(3095)가 아직 파트너 미등록 상태라 `catalogs`(목록)를 포함한 거의 모든 GET이 `errorCode: 5002`로 막히고, 실제 SUCCESS 응답 shape은 미관측이다. 유일한 예외는 `products create`의 request body — 콘솔 SPA의 공유 `IAPProductEditor` 폼 컴포넌트를 정적 분석해 필드명·검증 규칙을 복원했다(아래 "products create — inferred body shape"). 파트너 등록 후 재관측이 필요한 항목은 각 섹션에 명시.

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-purchase/catalogs` | 상품 목록 | ⚠️ (5002 게이트만 ✅) |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-purchase/catalog/<product_id>` | 상품 상세 | ⚠️ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-purchase/orders` | 주문 목록 | ⚠️ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-purchase/refunds` | 환불 목록 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-purchase/product/inspection` | 상품 등록 + 검수 제출 (원샷) | ⚠️ |

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
- **Capture status**: ⚠️ inferred — request body는 정적 분석으로 복원, **응답은 물론 request 자체도 라이브로 호출된 적이 없다** (SECRET-HANDLING: 이 endpoint는 read-only가 아니라 실제 상품을 등록하고 검수 큐에 올리는 mutation이라, 메인테이너 승인 게이트(`--confirm`) 뒤에서만 실행된다).
- 미니앱 등록(`POST /mini-app/review`, [`mini-apps.md`](./mini-apps.md) "Update mode")과 같은 패턴 — **등록과 검수 제출이 분리된 두 endpoint가 아니라 단일 POST**. dual-mode(create vs update)는 이 endpoint가 아니라 `PUT .../product/<productId>/inspection`(수정)으로 나뉘어 있다는 점만 미니앱과 다르다.

### products create — inferred body shape

콘솔 SPA의 상품 등록/수정 공용 폼 컴포넌트 `IAPProductEditor`(`IAPProductEditor.BQeOKeLb.js`)의 `handleSubmit` 조립부와, 등록 페이지 wrapper(`index.C6av4Lke.js`)를 추적해 복원:

```ts
// IAPProductEditor의 handleSubmit(R => onSubmit({...R, discountPolicies, currency, defaultLocale}))
// 등록 페이지의 onSubmit(u => POST(".../product/inspection", {...u, workspaceId, miniAppId}))
{
  type: 'CONSUMABLE' | 'NON_CONSUMABLE' | 'SUBSCRIPTION',
  name: string,                 // <=30 chars (공백 포함), react-hook-form validate: `length>30`
  description: string,          // <=45 chars, validate: `length>45`
  price: number,                // 400..1,400,000 KRW, validate: `<400||>14e5` — "공급가", GET 응답의 `netPrice`와 동일 개념
  iconImgUrl: string,            // 이미 업로드된 이미지 URL (별도 업로드 endpoint 필요 — 미확인)
  minDeploymentId: number,       // 최소 지원 번들 deploymentId
  postInspectionStatus: 'ACTIVE' | 'INACTIVE',  // 검수 통과 후 즉시노출(ACTIVE) 여부, 기본 INACTIVE
  renewalCycle?: 'WEEKLY' | 'MONTHLY' | 'YEARLY',  // type===SUBSCRIPTION일 때만 필수, 폼에 아예 안 보임
  discountPolicies: Array<{...}>,  // type===SUBSCRIPTION이 아니면 항상 []
  currency: 'KRW',               // 폼이 하드코딩 (`Ve="KRW"`)
  defaultLocale: 'KO_KR',        // 폼이 하드코딩 (`_e="KO_KR"`)
}
```

**CLI가 이 body에서 의도적으로 빼는 필드**: 폼은 `isAgreed`(체크박스 "위 내용을 확인했어요. 설정된 내용으로 상품을 등록할게요.")도 react-hook-form 필드로 등록돼 있어, `handleSubmit`의 스프레드(`{...R, ...}`)에 구조적으로 포함될 수 있다 — 다만 이게 실제로 서버 request body에 실려 전송되는지, 서버가 이를 검증하는지는 미확인이다(등록 마법사의 법정 동의 체크박스들이 서버 payload엔 안 실리는 것과 같은 패턴일 가능성이 높음 — [`mini-apps.md`](./mini-apps.md) "Server-side validation" 참고). CLI는 이 필드를 body에 넣지 않는 대신, 동일한 의도를 `--confirm` CLI-level 게이트로 강제한다(`aitcc app iap products create`는 `--dry-run` 없이 `--confirm` 없으면 거부, exit 2). 실제로 서버가 `isAgreed`를 요구한다면 첫 라이브 시도에서 명확한 validation 에러로 드러날 것이고, 그때 이 문서와 body 조립 로직을 보강한다.

**할인 정책(`discountPolicies`) CLI 미노출**: 폼은 `FREE_TRIAL`/`NEW_SUBSCRIPTION`/`RETURNING` 세 고정 슬롯을 체크박스로 켜고 각각 다른 필드(`period` vs `durationMonths`+`discountedNetPrice`)를 받지만, issue #220 스코프가 "discount/settlement/analytics 명령은 후속"으로 명시했으므로 `aitcc app iap products create`는 항상 `discountPolicies: []`를 보낸다. API 레이어(`createIapProduct`)는 향후를 위해 입력 타입을 열어 두었다.

**실행 정책**: 이 함수는 `--dry-run`으로 payload를 미리보기(네트워크 호출 없음)하거나 `--confirm`으로 실제 제출하는 두 경로만 있다. 이 repo의 자동 테스트·dog-food 검증은 **mocked fetch로만** 이 함수를 호출한다 — 실제 콘솔에 대한 첫 호출은 메인테이너가 명시적으로 `--confirm`을 붙여 실행하는 시점까지 일어나지 않는다.

## 짝 문서

- [`workspaces.md`](./workspaces.md) "partner" — IAP 전체를 게이트하는 거래처(파트너) 등록 상태.
- [`_error-codes.md`](./_error-codes.md) `5002` — 파트너 미등록 게이트 코드.
- [`mini-apps.md`](./mini-apps.md) "Update mode" — "등록+검수 제출 원샷" 패턴의 원조 사례(미니앱 등록).
