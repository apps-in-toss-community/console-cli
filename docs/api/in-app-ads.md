# In-app advertising (IAA)

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

미니앱의 인앱 광고(IAA) 지면(placement group) 목록과 어뷰징/노출차단 상태 조회 endpoint 묶음. 앱-scope라는 점에서 [`in-app-purchase.md`](./in-app-purchase.md)와 같은 축이고, 워크스페이스 레벨의 "프로모션 머니"([`workspaces.md`](./workspaces.md) "promotion-money")와는 다른 도메인이다 — 프로모션 머니는 워크스페이스가 **자사 앱을 홍보하려고 지출**하는 예산, IAA는 **인앱 광고를 노출해 벌어들이는 수익** 축이다.

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-ads-v2/placement-groups` | 광고 지면 목록 | ✅ confirmed |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/in-app-ads-v2/abuse-status` | 어뷰징/노출차단 상태 | ✅ confirmed |

## `GET .../in-app-ads-v2/placement-groups` — 광고 지면 목록

- **Used by**: [`src/api/in-app-ads.ts#fetchAdsPlacementGroups`](../../src/api/in-app-ads.ts), `aitcc app ads placement-groups ls`
- **Capture status**: ✅ confirmed (2026-07-24, workspace 3095 / app 31146) — 200, 빈 배열. 아직 이 앱에 등록된 광고 지면이 없다.
- **Auth**: 세션 쿠키

### Response (관측)

```json
{ "resultType": "SUCCESS", "success": [] }
```

지면이 등록된 이후의 entry shape은 미관측 — CLI는 각 항목을 opaque `Record<string, unknown>`로 통과시키고, 사람이 읽는 출력은 `id`/`name`/`status` 필드가 있으면 그것만 best-effort로 뽑아 보여준다 (없으면 `-`).

## `GET .../in-app-ads-v2/abuse-status` — 어뷰징/노출차단 상태

- **Used by**: [`src/api/in-app-ads.ts#fetchAdsAbuseStatus`](../../src/api/in-app-ads.ts), `aitcc app ads abuse-status`
- **Capture status**: ✅ confirmed (2026-07-24, workspace 3095 / app 31146)
- **Auth**: 세션 쿠키

### Response (관측)

```json
{
  "resultType": "SUCCESS",
  "success": {
    "abuseLevel": "NONE",
    "isServingBlocked": false,
    "blockedPlacementGroups": []
  }
}
```

- `abuseLevel`: 문자열 enum으로 추정 (관측된 값은 `"NONE"`뿐 — 다른 값은 미관측, CLI는 그대로 pass-through).
- `isServingBlocked`: `true`면 광고 노출이 차단된 상태. CLI는 이 경우 콘솔의 광고 정책 위반 안내를 확인하라는 자연어 안내를 덧붙인다.
- `blockedPlacementGroups`: 차단된 지면 목록. 빈 배열만 관측됨 — 항목 shape 미확인.

## 짝 문서

- [`in-app-purchase.md`](./in-app-purchase.md) — 같은 앱-scope 패턴(`workspaces/<wid>/mini-app/<mini_app_id>/...`)을 쓰는 인앱결제 도메인.
- [`workspaces.md`](./workspaces.md) "promotion-money" — 워크스페이스 레벨의 자사 앱 홍보 지출 축(IAA 수익과는 다른 축이니 혼동 주의).
