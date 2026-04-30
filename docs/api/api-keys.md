# API Keys

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

워크스페이스-scope의 콘솔 API key (배포 자동화 등 용도). 미니앱-scope의 인증서(`certs`)와 별도. 자세한 인증서는 [`mini-app-misc.md`](./mini-app-misc.md) 참고.

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/api-keys` | 목록 | ✅ (빈 list) |
| POST | `/workspaces/<wid>/api-keys` | 발급 | ❌ |
| PUT | `/workspaces/<wid>/api-keys/<api_key_id>/disable` | 비활성화 | ❌ |

## `GET /workspaces/<wid>/api-keys` — 목록

- **Used by**: [`src/api/api-keys.ts#fetchApiKeys`](../../src/api/api-keys.ts), `aitcc app keys` / `aitcc workspace keys` (TBD)
- **Capture status**: ✅ confirmed (빈 list만 — 발급 사례 미보유)
- **Auth**: 세션 쿠키

### Response (빈 list)

```json
{
  "resultType": "SUCCESS",
  "success": []
}
```

### Response (발급된 key 있음, inferred)

코드 ([`src/api/api-keys.ts`](../../src/api/api-keys.ts))는 다음 필드명들을 fallback chain으로 받는다 — 실제 어느 이름으로 오는지는 미확정:

```jsonc
{
  "resultType": "SUCCESS",
  "success": [
    {
      "id": "<api_key_id>",          // or "apiKeyId" or "keyId"
      "name": "...",                  // or "apiKeyName" or "keyName" or "description"
      // 외 필드는 코드의 `extra`로 그대로 보존
    }
  ]
}
```

발급 사례가 생기면 이 항목을 confirmed로 올리고 fallback chain을 정리할 예정.

## 미캡처 endpoint

- `POST /workspaces/<wid>/api-keys` — 발급. payload/response 미상.
- `PUT /workspaces/<wid>/api-keys/<api_key_id>/disable` — 비활성화. payload/response 미상.
