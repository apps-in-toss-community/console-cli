// Map console-API `errorCode` values into actionable user messages.
//
// Two shapes coexist on the wire (envelope: `{resultType:'FAIL', error:
// {errorCode, reason, ...}}`):
//
//   1. Numeric strings — `"4046"`, `"4032"`, `"4010"`. Catalogued in
//      `docs/api/_error-codes.md`. CLI does not rewrite these; the raw
//      `error.reason` is already a Korean sentence the console UI shows
//      verbatim, and we surface the same string so behaviour matches what
//      a user sees in the browser. This module returns `null` for that
//      case so callers fall back to the existing message.
//
//   2. Prefix-form (`<camelCaseDomain>.<PascalCaseReason>`) — e.g.
//      `"miniApp.InvalidTitle"` from `POST /mini-app/review`. Discovered
//      during sdk-example#39 dog-food. The accompanying `reason` is
//      sometimes generic ("앱 영문 이름은 영어, 숫자, 공백, 콜론(:)만 사용
//      가능해요") and the LLM consumer in agent-plugin has no way to know
//      the rule from the code alone. For the small set we've directly
//      observed, surface a single actionable line. Unknown prefix codes
//      pass through with the code embedded in the message so a downstream
//      reader at least sees the dotted identifier rather than just a raw
//      reason — they get added to the catalog when next observed.
//
// The numeric/prefix split mirrors the table layout in
// `docs/api/_error-codes.md` exactly so the doc and the code stay in sync;
// `_error-codes.md` is the source of truth for which prefix codes are
// known.

const PREFIX_ERROR_CODE_PATTERN = /^[a-z][a-zA-Z0-9]*\.[A-Z][a-zA-Z0-9]+$/;

export function isPrefixFormErrorCode(code: string): boolean {
  return PREFIX_ERROR_CODE_PATTERN.test(code);
}

// Known prefix codes mapped to a one-line action sentence. Keep entries
// terse (no leading bullet, no trailing period) — the caller wraps them
// into a longer string with the raw code/reason.
//
// Only add an entry once the code has been observed end-to-end with a
// known fix. Speculation belongs in a TODO, not here — the unknown-prefix
// path already surfaces the code so a user can search the catalog.
const KNOWN_PREFIX_MESSAGES: Record<string, string> = {
  'miniApp.InvalidTitle':
    'titleKo violates the server rule (≤ 10 code points excluding spaces, only Korean/English letters, digits, spaces, and ":·?"). Edit `titleKo` in aitcc.yaml.',
  'miniApp.InvalidTitleEn':
    'titleEn violates the server rule (≤ 15 code points excluding spaces, only English letters/digits/spaces/`:·?`, and each word title-case — first letter uppercase, rest lowercase; `AITC`-style all-caps tokens are rejected). Edit `titleEn` in aitcc.yaml.',
};

export interface DescribeApiErrorInput {
  /** Raw `error.errorCode` from the Toss envelope (may be any string). */
  readonly errorCode: string | undefined;
  /** Raw `error.reason` from the Toss envelope. */
  readonly reason: string | undefined;
  /**
   * The fallback message the caller would have used absent prefix mapping
   * (typically `TossApiError.message`). Returned verbatim when the code is
   * empty or numeric so existing behaviour is preserved.
   */
  readonly fallback: string;
}

/**
 * Compose the user-visible message for a Toss API error.
 *
 * Returns the original `fallback` for numeric / null / unknown-shape codes
 * — those keep existing behaviour byte-for-byte. For prefix-form codes,
 * a known mapping is prepended to the fallback so the JSON `message`
 * field carries both the actionable hint and the underlying server text.
 * For unknown prefix codes, the dotted code is embedded in a `(<code>)`
 * marker so a downstream reader sees the identifier they need to look
 * up in `docs/api/_error-codes.md`.
 *
 * `errorCode` itself is left to the caller — this only shapes `message`.
 */
export function describeApiError(input: DescribeApiErrorInput): string {
  const { errorCode, reason, fallback } = input;
  if (!errorCode) return fallback;
  if (!isPrefixFormErrorCode(errorCode)) return fallback;
  const mapped = KNOWN_PREFIX_MESSAGES[errorCode];
  if (mapped !== undefined) {
    const reasonSuffix = reason ? ` (server reason: ${reason})` : '';
    return `${mapped}${reasonSuffix}`;
  }
  // Unknown prefix code: surface the dotted identifier so logs and JSON
  // consumers can grep for it, but don't claim a meaning we haven't
  // verified. Reason text is appended when present so the user still
  // sees the server's Korean explanation.
  if (reason) return `(${errorCode}) ${reason}`;
  return `(${errorCode}) ${fallback}`;
}
