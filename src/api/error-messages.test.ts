import { describe, expect, it } from 'vitest';
import { describeApiError, isPrefixFormErrorCode } from './error-messages.js';

describe('isPrefixFormErrorCode', () => {
  it('accepts <camelCaseDomain>.<PascalCaseReason>', () => {
    expect(isPrefixFormErrorCode('miniApp.InvalidTitle')).toBe(true);
    expect(isPrefixFormErrorCode('miniApp.InvalidTitleEn')).toBe(true);
    expect(isPrefixFormErrorCode('workspace.SomethingBad')).toBe(true);
  });

  it('rejects numeric codes (the legacy shape)', () => {
    expect(isPrefixFormErrorCode('4046')).toBe(false);
    expect(isPrefixFormErrorCode('4010')).toBe(false);
    expect(isPrefixFormErrorCode('500')).toBe(false);
  });

  it('rejects malformed dotted strings so we do not over-match', () => {
    // No dot.
    expect(isPrefixFormErrorCode('miniApp')).toBe(false);
    // Domain must start lowercase.
    expect(isPrefixFormErrorCode('MiniApp.Invalid')).toBe(false);
    // Reason must start uppercase.
    expect(isPrefixFormErrorCode('miniApp.invalid')).toBe(false);
    // Two dots: not the form we map.
    expect(isPrefixFormErrorCode('a.b.C')).toBe(false);
    // Empty reason segment.
    expect(isPrefixFormErrorCode('miniApp.')).toBe(false);
    expect(isPrefixFormErrorCode('')).toBe(false);
  });
});

describe('describeApiError', () => {
  it('maps a known prefix code (miniApp.InvalidTitle) to an actionable line and appends server reason', () => {
    const message = describeApiError({
      errorCode: 'miniApp.InvalidTitle',
      reason: '앱 이름은 최대 10자입니다',
      fallback: 'Toss API error miniApp.InvalidTitle: 앱 이름은 최대 10자입니다 (HTTP 400)',
    });
    expect(message).toContain('titleKo');
    expect(message).toContain('aitcc.yaml');
    // Server reason is preserved so the user still sees the Korean
    // explanation and the message stays diagnosable.
    expect(message).toContain('앱 이름은 최대 10자입니다');
  });

  it('maps miniApp.InvalidTitleEn to a title-case + length hint', () => {
    const message = describeApiError({
      errorCode: 'miniApp.InvalidTitleEn',
      reason: '앱 영문 이름은 영어, 숫자, 공백, 콜론(:)만 사용 가능해요',
      fallback: 'Toss API error miniApp.InvalidTitleEn: ... (HTTP 400)',
    });
    expect(message).toContain('titleEn');
    expect(message).toContain('title-case');
  });

  it('returns the fallback verbatim for unknown prefix codes (do not invent a meaning)', () => {
    // `TossApiError.message` already templates the dotted code into
    // `Toss API error <code>: <reason> (HTTP …)`, so the unknown-prefix
    // branch just defers to that fallback rather than re-wrapping the
    // code and producing a duplicated identifier.
    const fallback = 'Toss API error something.NewlyDiscovered: 서버측 사유 (HTTP 400)';
    const message = describeApiError({
      errorCode: 'something.NewlyDiscovered',
      reason: '서버측 사유',
      fallback,
    });
    expect(message).toBe(fallback);
    // Sanity-check that the fallback already exposes the dotted
    // identifier, which is the assumption the no-rewrap path relies on.
    expect(message).toContain('something.NewlyDiscovered');
  });

  it('returns the fallback verbatim for numeric error codes (no regression on existing behaviour)', () => {
    const fallback = 'Toss API error 4046: 검수중인 요청이 있어 검수요청을 할 수 없어요 (HTTP 400)';
    const message = describeApiError({ errorCode: '4046', reason: '검수중', fallback });
    expect(message).toBe(fallback);
  });

  it('returns the fallback verbatim when errorCode is missing or empty', () => {
    const fallback = 'Toss API error : 카테고리 정보가 없음 (HTTP 400)';
    expect(
      describeApiError({ errorCode: undefined, reason: '카테고리 정보가 없음', fallback }),
    ).toBe(fallback);
    expect(describeApiError({ errorCode: '', reason: '카테고리 정보가 없음', fallback })).toBe(
      fallback,
    );
  });

  it('returns the fallback verbatim when an unknown prefix code arrives with no reason (no double-wrap)', () => {
    // Regression guard for an earlier shape that returned
    // `(<code>) <fallback>`, which produced
    // `(something.Mystery) Toss API error something.Mystery: ? (HTTP 400)`
    // — the dotted code was duplicated. The describer now defers to
    // `fallback`, which already contains the code via the
    // `TossApiError.message` template.
    const fallback = 'Toss API error something.Mystery: ? (HTTP 400)';
    const message = describeApiError({
      errorCode: 'something.Mystery',
      reason: undefined,
      fallback,
    });
    expect(message).toBe(fallback);
    expect(message.startsWith('(')).toBe(false);
  });
});
