# Notices (별도 호스트)

콘솔의 공지사항(공지)은 다른 endpoint들과 **다른 호스트**에 있다.

- **Host**: `https://api-public.toss.im/api-public/v3/ipd-thor/api/v1`
- **Workspace ID**: `129` (고정 — 모든 사용자 공유 워크스페이스)
- **Auth**: 세션 쿠키. 캡처 시점의 쿠키 도메인이 `.toss.im`이라 `api-public.toss.im` 호스트에도 자동 매칭됨.

CLI는 이 서비스 전용 base를 따로 두고 호출한다 ([`src/api/ipd-thor.ts`](../../src/api/ipd-thor.ts)).

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/129/posts` | 공지 목록 (page-based) | ⚠️ |
| GET | `/workspaces/129/posts/<post_id>` | 공지 상세 | ❌ |
| GET | `/workspaces/129/categories` | 공지 카테고리 | ⚠️ |

## `GET /workspaces/129/posts` — 공지 목록

- **Used by**: [`src/api/ipd-thor.ts#fetchNotices`](../../src/api/ipd-thor.ts), `aitcc notices ls`
- **Capture status**: ⚠️ inferred (관측됨, 본문은 미체크인)
- **Query**:
  - `page=<int>` — **1-indexed**. CLI가 `page=0` 보내도 서버는 `page: 1`로 echo. (Toss-style 0-indexed paging이 아님.)
  - `size=<int>` — 페이지 크기, default 20
  - `title__icontains=<string>` (optional) — title 부분 일치 검색

### Response

```jsonc
{
  "resultType": "SUCCESS",
  "success": {
    "page": 1,
    "pageSize": 20,
    "count": <total>,
    "next": "<url>" | null,
    "previous": "<url>" | null,
    "results": [
      // post object — 정확한 필드는 미확정. CLI는 `Record<string, unknown>` 그대로 노출
    ]
  }
}
```

**메모**:

- `next`/`previous`는 절대 URL일 수 있음 (DRF 스타일).
- 다른 console endpoint들과 페이지네이션 컨벤션이 다르다 (`{contents, totalPage, currentPage}` 아님).

## `GET /workspaces/129/categories` — 공지 카테고리

- **Used by**: [`src/api/ipd-thor.ts#fetchNoticeCategories`](../../src/api/ipd-thor.ts), `aitcc notices categories`
- **Capture status**: ⚠️ inferred

### Response

```json
{
  "resultType": "SUCCESS",
  "success": [
    {
      "id": <int>,
      "name": "...",
      "postCount": <int>,
      "children": []
    }
  ]
}
```

`children`은 항상 빈 array로 관측됨.

## `GET /workspaces/129/posts/<post_id>` — 공지 상세

- **Used by**: [`src/api/ipd-thor.ts#fetchNoticePost`](../../src/api/ipd-thor.ts), `aitcc notices show <id>`
- **Capture status**: ❌ not captured (sidebar list만 호출됨)
- 코드는 list와 같은 envelope을 가정하고 동작 (실제 호출 사례 누적 시 본 항목 보강).
