import { describe, expect, it } from 'vitest';
import { deriveReviewState, findReviewEntry, pickMiniAppView, reviewStateFor } from './app.js';

// parseNonNegativeInt is not exported (rendering would widen the surface
// without enough reuse) — ratings parsing is covered at the CLI level via
// integration tests in env where the CLI spawns.

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

// `pickMiniAppView` is the little helper that decides which side of the
// /with-draft envelope gets rendered. It matters because until an app is
// approved, `current` is null while `draft` holds every field the user
// entered — picking the wrong view is exactly what led us to believe
// `register` was dropping fields in the first place.
describe('pickMiniAppView', () => {
  const currentSide = { miniApp: { title: 'published', description: 'p' } };
  const draftSide = { miniApp: { title: 'editing', detailDescription: 'd' } };

  it('returns draft when asked (draft is the safe default)', () => {
    expect(pickMiniAppView({ current: currentSide, draft: draftSide }, 'draft')).toEqual(
      draftSide.miniApp,
    );
  });

  it('returns current when asked', () => {
    expect(pickMiniAppView({ current: currentSide, draft: draftSide }, 'current')).toEqual(
      currentSide.miniApp,
    );
  });

  it('falls back to draft for current-of-unreviewed-app so callers can tell the two apart via view', () => {
    expect(pickMiniAppView({ current: null, draft: draftSide }, 'current')).toBeNull();
    // Explicit: asking for `current` when it's null returns null (not draft)
    // so agent-plugin can distinguish "not reviewed" from "reviewed and published".
  });

  it("draft view on an app that has not been drafted (shouldn't happen in practice) returns null", () => {
    expect(pickMiniAppView({ current: null, draft: null }, 'draft')).toBeNull();
  });

  it('merged: draft overrides current field-by-field', () => {
    const merged = pickMiniAppView({ current: currentSide, draft: draftSide }, 'merged');
    expect(merged).toEqual({
      title: 'editing',
      description: 'p',
      detailDescription: 'd',
    });
  });

  it('merged: falls back to the present side when only one exists', () => {
    expect(pickMiniAppView({ current: currentSide, draft: null }, 'merged')).toEqual(
      currentSide.miniApp,
    );
    expect(pickMiniAppView({ current: null, draft: draftSide }, 'merged')).toEqual(
      draftSide.miniApp,
    );
  });

  it('handles envelopes whose miniApp field is missing or wrong-typed', () => {
    // A side with no `miniApp` (or with a non-object value) is normalised to null
    // rather than crashing. Protects against a future schema change where the
    // server swaps the nested key but we haven't caught up yet.
    expect(pickMiniAppView({ current: {}, draft: null }, 'draft')).toBeNull();
    expect(pickMiniAppView({ current: { miniApp: 'oops' }, draft: null }, 'current')).toBeNull();
    expect(pickMiniAppView({ current: { miniApp: [] }, draft: null }, 'current')).toBeNull();
  });
});

// deriveReviewState encodes the UI "검토 중" banner rule so `app status`
// has a single place to evolve when the rejected / approved shapes come in
// from a real review cycle. Documented combinations live in app.ts above
// the function; these tests pin each one.
describe('deriveReviewState', () => {
  const base = { current: null, draft: { miniApp: {} }, approvalType: null, rejectedMessage: null };

  it('not-submitted when approvalType is null', () => {
    expect(deriveReviewState({ ...base }).state).toBe('not-submitted');
  });

  it('under-review when approvalType=REVIEW and current is null', () => {
    expect(deriveReviewState({ ...base, approvalType: 'REVIEW', current: null }).state).toBe(
      'under-review',
    );
  });

  it('rejected when rejectedMessage is a non-null string', () => {
    const s = deriveReviewState({
      ...base,
      approvalType: 'REVIEW',
      current: null,
      rejectedMessage: 'violates policy X',
    });
    expect(s.state).toBe('rejected');
    expect(s.rejectedMessage).toBe('violates policy X');
  });

  it('approved when current row exists and there is no fresh draft', () => {
    expect(
      deriveReviewState({
        current: { miniApp: { status: 'LIVE' } },
        draft: null,
        approvalType: 'REVIEW',
        rejectedMessage: null,
      }).state,
    ).toBe('approved');
  });

  it('approved-with-edits when both current and draft exist', () => {
    expect(
      deriveReviewState({
        current: { miniApp: { status: 'LIVE' } },
        draft: { miniApp: { status: 'PREPARE' } },
        approvalType: 'REVIEW',
        rejectedMessage: null,
      }).state,
    ).toBe('approved-with-edits');
  });

  it('unknown for approvalType values other than REVIEW (forward-compat)', () => {
    // A future approvalType we haven't observed shouldn't get silently mapped
    // to under-review — flag it as unknown so we notice and add a branch.
    expect(
      deriveReviewState({
        ...base,
        approvalType: 'FUTURE_TYPE',
        current: null,
      }).state,
    ).toBe('unknown');
  });

  it('reports hasCurrent/hasDraft flags truthfully so JSON consumers have the raw signal too', () => {
    const s = deriveReviewState({
      current: { miniApp: {} },
      draft: { miniApp: {} },
      approvalType: 'REVIEW',
      rejectedMessage: null,
    });
    expect(s.hasCurrent).toBe(true);
    expect(s.hasDraft).toBe(true);
  });
});
