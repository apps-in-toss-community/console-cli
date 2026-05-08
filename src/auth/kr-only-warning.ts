// Single source of truth for the KR-only cookie warning shown on every
// surface that emits or accepts an exported session blob.
//
// The console session cookies (`TBIZAUTH` and the rest) are country-bound
// to KR residential IPs. The same blob succeeds from a Korean machine but
// returns 401 / errorCode 4010 from non-KR egress (GHA-hosted runners,
// most cloud providers' US/EU regions). Spike data + decision rationale:
// docs/api/auth-session.md "Cookie portability (실측)".
//
// Keeping the wording in one place avoids drift between `auth export` /
// `auth import` stderr, --json envelopes, --help blurbs, README, and docs.

export const KR_ONLY_WARNING_KEY = 'kr-only-cookies' as const;

export const KR_ONLY_WARNING_SHORT =
  'console session cookies are KR-only — they fail with errorCode 4010 from non-KR IPs (e.g. GitHub-hosted runners).';

export const KR_ONLY_WARNING_LONG = `${KR_ONLY_WARNING_SHORT} See docs/api/auth-session.md.`;
