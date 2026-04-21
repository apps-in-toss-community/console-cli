import { describe, expect, it } from 'vitest';
import { findReviewEntry, reviewStateFor } from './app.js';

// `app ls` joins two endpoints (`mini-app` list + `mini-apps/review-status`)
// by best-effort id match. The helpers are pure and the three-key fallback
// logic is exactly the place a silent "simplify" refactor would regress.

describe('findReviewEntry', () => {
  it('matches by `id` (string)', () => {
    const entries = [{ id: 'abc', reviewState: 'APPROVED' }];
    expect(findReviewEntry(entries, 'abc')).toBe(entries[0]);
  });

  it('matches by `miniAppId` (number, with string target via coercion)', () => {
    const entries = [{ miniAppId: 999, reviewState: 'PENDING' }];
    expect(findReviewEntry(entries, '999')).toBe(entries[0]);
  });

  it('matches by `appId` fallback', () => {
    const entries = [{ appId: 42, reviewState: 'REJECTED' }];
    expect(findReviewEntry(entries, 42)).toBe(entries[0]);
  });

  it('prefers `id` over `miniAppId` when both are present', () => {
    const entries = [{ id: 'primary', miniAppId: 'secondary' }];
    expect(findReviewEntry(entries, 'primary')).toBe(entries[0]);
    expect(findReviewEntry(entries, 'secondary')).toBeNull();
  });

  it('returns null on miss', () => {
    const entries = [{ id: 'abc' }, { miniAppId: 'def' }];
    expect(findReviewEntry(entries, 'ghi')).toBeNull();
  });

  it('returns null on empty list', () => {
    expect(findReviewEntry([], 'abc')).toBeNull();
  });
});

describe('reviewStateFor', () => {
  it('returns undefined on null entry', () => {
    expect(reviewStateFor(null)).toBeUndefined();
  });

  it('reads `reviewState` when present', () => {
    expect(reviewStateFor({ reviewState: 'APPROVED' })).toBe('APPROVED');
  });

  it('falls back to `status`', () => {
    expect(reviewStateFor({ status: 'PENDING' })).toBe('PENDING');
  });

  it('prefers `reviewState` over `status` when both are present', () => {
    expect(reviewStateFor({ reviewState: 'APPROVED', status: 'PENDING' })).toBe('APPROVED');
  });

  it('returns undefined when the field is not a string', () => {
    expect(reviewStateFor({ reviewState: 123 })).toBeUndefined();
    expect(reviewStateFor({})).toBeUndefined();
  });
});
