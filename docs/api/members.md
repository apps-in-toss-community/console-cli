# Members · Invites

워크스페이스 멤버 조회·초대·제거 관련 endpoint. `aitcc members` 명령군의 권위 문서.

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/members` | 멤버 목록 | ✅ |
| GET | `/workspaces/<wid>/members/me` | 내 멤버 정보 (per-workspace) | ⚠️ |
| GET | `/workspaces/<wid>/member-count` | 멤버 수 | ⚠️ |
| POST | `/workspaces/<wid>/invites/send/by-email` | 이메일로 초대 발송 (UI "+ 초대하기") | ⚠️ |
| POST | `/workspaces/<wid>/invites` | 초대 생성 (별도 경로 — UI 호출자 미특정) | ⚠️ |
| POST | `/workspaces/<wid>/invites/accept` | 초대 수락 | ⚠️ |
| POST | `/workspaces/<wid>/invites/reject` | 초대 거절 | ⚠️ |
| DELETE | `/workspaces/<wid>/invites` | 초대 취소 | ⚠️ |
| DELETE | `/workspaces/<wid>/members/<member_biz_user_no>` | 멤버 제거 | ⚠️ |

## `GET /workspaces/<wid>/members` — 멤버 목록

- **Used by**: [`src/api/members.ts#fetchWorkspaceMembers`](../../src/api/members.ts), `aitcc members ls`
- **Capture status**: ✅ confirmed (dog-food 2026-05-08, workspace 3095)

### Response

```json
{
  "resultType": "SUCCESS",
  "success": [
    {
      "workspaceId": 3095,
      "bizUserNo": <biz_user_no>,
      "name": "<name>",
      "email": "<email>",
      "status": "ACTIVE",
      "role": "OWNER",
      "isOwnerDelegationRequested": false,
      "isAdult": true
    }
  ]
}
```

**메모**:

- `bizUserNo`가 person-stable identifier. 같은 사람이 여러 워크스페이스에 속해 있어도 동일하다 → `DELETE /workspaces/<wid>/members/<member_biz_user_no>`의 path param 키와 일치 (콘솔 번들 정적 분석으로 확인된 path param 이름은 `memberBizUserNo`).
- `status`: 관측값 `"ACTIVE"`. `"INVITED"`, `"REMOVED"` 등 추가 enum은 미관측.
- `role`: `"OWNER"`, `"MEMBER"` 등.
- `isAdult`는 한국 성인 인증 (Korean adult-verification) 플래그. PII로 분류돼 `members ls --json`에서 의도적으로 drop된다 — 자세한 경위는 [`src/commands/members.ts`](../../src/commands/members.ts) 코멘트 참고.

## `GET /workspaces/<wid>/members/me` — 내 멤버 정보 (per-workspace)

- **Used by**: 콘솔 SPA. CLI 미사용 (전역 `whoami`는 `/members/me/user-info` 사용 — [`auth-session.md`](./auth-session.md)).
- **Capture status**: ⚠️ inferred (콘솔 번들 정적 분석으로 path/method만 확인)
- **Method**: `GET`
- 워크스페이스 진입 시 SPA가 자동 호출. shape 미캡처.

## `GET /workspaces/<wid>/member-count` — 멤버 수

- **Used by**: 콘솔 SPA의 워크스페이스 헤더 등.
- **Capture status**: ⚠️ inferred (콘솔 번들 정적 분석으로 path/method만 확인)
- **Method**: `GET`

## Invite 관련 endpoint

> **Capture status (전체)**: ⚠️ inferred. 콘솔 bootstrap 번들(`bootstrap.Bz6K-BHG.js` @ 2026-05-08) 정적 분석으로 **method/path는 확정**됐지만, request body shape과 response body shape은 미캡처다. 호출자가 minified alias만 사용해 인라인 schema가 번들에 남지 않는다 (export 매핑은 확인됨: `oit→aR`, `rit→aM`, `eit→as`, `tit→av`, `ait→aQ`, `nit→aP`).
>
> **CLI 매핑 (잠정)**: `aitcc members invite <email>`은 `POST .../invites/send/by-email`로 매핑할 가능성이 가장 높다 (UI "+ 초대하기" 버튼이 호출하는 경로로 추정 — 도메인 의미상 by-email이 일관). `aitcc members remove <biz_user_no>`는 `DELETE .../members/<member_biz_user_no>`. 단, **두 endpoint 모두 라이브 캡처(payload + response + errorCode 매핑) 완료 전엔 구현하지 않는다.** 캡처 결과에 따라 `POST .../invites` (별도 경로)가 더 맞는 매핑일 수도 있다. 두 명령 모두 first cut PR scope 밖.

### `POST /workspaces/<wid>/invites/send/by-email` — 이메일 초대

- **Capture status**: ⚠️ inferred. method/path만 확인.
- **추정 사용처**: 콘솔 UI "+ 초대하기" 버튼.
- **추정 payload**: `{ email: <string>, role?: <string> }` — 미검증.
- **CLI 짝**: `aitcc members invite <email>` (구현 보류).

### `POST /workspaces/<wid>/invites` — 초대 생성 (다른 경로)

- **Capture status**: ⚠️ inferred. method/path만 확인.
- **메모**: `send/by-email`과 별도로 존재. UI상 호출자 미특정 — 단체 초대(role/email batch)일 가능성. 라이브 캡처 전엔 사용 금지.

### `POST /workspaces/<wid>/invites/accept` · `POST /workspaces/<wid>/invites/reject`

- **Capture status**: ⚠️ inferred. method/path만 확인.
- **사용처**: `GET /workspaces/invited`로 받아온 초대를 수락/거절. 콘솔 SPA의 초대 알림 배지 흐름.
- **CLI scope**: 0.1.x 범위 밖. 받은 초대 관리는 `aitcc workspace`가 아닌 별도 namespace로 다뤄야 하는지 미결.

### `DELETE /workspaces/<wid>/invites` — 초대 취소

- **Capture status**: ⚠️ inferred. method/path만 확인.
- **사용처**: 초대 발송 후 pending 상태에서 취소. payload(어떤 초대를 취소하는지의 식별자 — inviteId? email?)는 미캡처.

### `DELETE /workspaces/<wid>/members/<member_biz_user_no>` — 멤버 제거

- **Capture status**: ⚠️ inferred. method/path 확정 (path param 이름 `memberBizUserNo`까지 번들에서 확인).
- **CLI 짝**: `aitcc members remove <biz_user_no>` (구현 보류).
- **사용처**: 워크스페이스 멤버 관리에서 OWNER가 다른 멤버 제거. OWNER가 자기 자신을 remove할 때의 동작은 미관측 (소유권 위임 흐름 별도).

## 다음 캡처 작업

invite/remove 명령 PR 진행 시 라이브 캡처 항목:

1. `POST .../invites/send/by-email` — UI "+ 초대하기" → 이메일 입력 → 발송. request body, response body, 이미 멤버/이미 초대된 경우 errorCode.
2. `DELETE .../members/<member_biz_user_no>` — UI 멤버 목록에서 제거. response body, 자기 자신 제거 시도 동작, OWNER 제거 시 동작.
3. `DELETE .../invites` — 초대 취소 UI flow. request body / query param으로 무엇을 식별하는지.
4. `POST .../invites` (별도 경로) — UI상 어떤 버튼이 호출하는지 식별 후 캡처. 식별 못하면 CLI에서 사용하지 않는다.

캡처 절차는 [`README.md`](./README.md) "캡처 방법" 참조.
