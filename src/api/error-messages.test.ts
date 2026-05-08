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

  it('falls back to "(<code>) <reason>" for unknown prefix codes (do not invent a meaning)', () => {
    const message = describeApiError({
      errorCode: 'something.NewlyDiscovered',
      reason: '서버측 사유',
      fallback: 'Toss API error something.NewlyDiscovered: 서버측 사유 (HTTP 400)',
    });
    // Code identifier is preserved so a downstream reader can grep for it
    // in docs/api/_error-codes.md.
    expect(message).toContain('something.NewlyDiscovered');
    expect(message).toContain('서버측 사유');
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

  it('handles unknown prefix code with no reason by surfacing the code in the message', () => {
    const fallback = 'Toss API error something.Mystery: ? (HTTP 400)';
    const message = describeApiError({
      errorCode: 'something.Mystery',
      reason: undefined,
      fallback,
    });
    expect(message).toContain('something.Mystery');
  });
});
