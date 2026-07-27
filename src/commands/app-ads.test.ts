import { describe, expect, it } from 'vitest';
import { formatPlacementGroupRow, validateCreateAdsPlacementGroupArgs } from './app-ads.js';

// Field-level rules are pinned against the create contract confirmed in
// issue #229 (console SPA placement-group wizard serialization logic +
// public developer docs, 2026-07-24): displayName<=40, rewardSettings
// required iff adFormat===REWARDED, adStyles (1-entry array) only for
// BANNER. `--category` is validated here only as a *shape* check (positive
// integer) when provided — issue #231 (2026-07-24) made it optional for
// non-BANNER formats, auto-resolving from the app's own category when
// omitted. That live-call resolution path is exercised in
// src/api/in-app-ads.test.ts (`resolveAdCategoryId`), not here — this file
// stays a pure-function suite with no fetch mocking.

describe('validateCreateAdsPlacementGroupArgs', () => {
  it('accepts a well-formed BANNER input (default banner-style NORMAL)', () => {
    const result = validateCreateAdsPlacementGroupArgs({
      name: 'Home banner',
      format: 'BANNER',
      category: undefined,
      rewardUnit: undefined,
      rewardAmount: undefined,
      bannerStyle: 'NORMAL',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        displayName: 'Home banner',
        adFormat: 'BANNER',
        adStyles: ['NORMAL'],
      });
    }
  });

  it('accepts a NATIVE_IMAGE banner style', () => {
    const result = validateCreateAdsPlacementGroupArgs({
      name: 'Feed banner',
      format: 'BANNER',
      category: undefined,
      rewardUnit: undefined,
      rewardAmount: undefined,
      bannerStyle: 'NATIVE_IMAGE',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.adStyles).toEqual(['NATIVE_IMAGE']);
  });

  it('rejects an unknown --format', () => {
    const result = validateCreateAdsPlacementGroupArgs({
      name: 'x',
      format: 'VIDEO',
      category: undefined,
      rewardUnit: undefined,
      rewardAmount: undefined,
      bannerStyle: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('format');
  });

  it('requires --name and rejects >40 chars', () => {
    const missing = validateCreateAdsPlacementGroupArgs({
      name: undefined,
      format: 'BANNER',
      category: undefined,
      rewardUnit: undefined,
      rewardAmount: undefined,
      bannerStyle: undefined,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.field).toBe('name');

    const tooLong = validateCreateAdsPlacementGroupArgs({
      name: 'x'.repeat(41),
      format: 'BANNER',
      category: undefined,
      rewardUnit: undefined,
      rewardAmount: undefined,
      bannerStyle: undefined,
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.field).toBe('name');

    const exact = validateCreateAdsPlacementGroupArgs({
      name: 'x'.repeat(40),
      format: 'BANNER',
      category: undefined,
      rewardUnit: undefined,
      rewardAmount: undefined,
      bannerStyle: undefined,
    });
    expect(exact.ok).toBe(true);
  });

  it('allows --category to be omitted when --format is INTERSTITIAL (auto-resolved later, issue #231)', () => {
    const omitted = validateCreateAdsPlacementGroupArgs({
      name: 'Full screen',
      format: 'INTERSTITIAL',
      category: undefined,
      rewardUnit: undefined,
      rewardAmount: undefined,
      bannerStyle: undefined,
    });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect(omitted.value).toEqual({
        displayName: 'Full screen',
        adFormat: 'INTERSTITIAL',
      });
      expect(omitted.value.categoryId).toBeUndefined();
    }

    const provided = validateCreateAdsPlacementGroupArgs({
      name: 'Full screen',
      format: 'INTERSTITIAL',
      category: '42',
      rewardUnit: undefined,
      rewardAmount: undefined,
      bannerStyle: undefined,
    });
    expect(provided.ok).toBe(true);
    if (provided.ok) {
      expect(provided.value).toEqual({
        displayName: 'Full screen',
        adFormat: 'INTERSTITIAL',
        categoryId: 42,
      });
    }
  });

  it('rejects a non-positive-integer --category', () => {
    const zero = validateCreateAdsPlacementGroupArgs({
      name: 'x',
      format: 'INTERSTITIAL',
      category: '0',
      rewardUnit: undefined,
      rewardAmount: undefined,
      bannerStyle: undefined,
    });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.field).toBe('category');

    const nonInt = validateCreateAdsPlacementGroupArgs({
      name: 'x',
      format: 'INTERSTITIAL',
      category: '3.5',
      rewardUnit: undefined,
      rewardAmount: undefined,
      bannerStyle: undefined,
    });
    expect(nonInt.ok).toBe(false);
    if (!nonInt.ok) expect(nonInt.field).toBe('category');
  });

  it('allows --category to be omitted when --format is REWARDED (auto-resolved later, issue #231) but still requires --reward-unit/--reward-amount', () => {
    const missingCategory = validateCreateAdsPlacementGroupArgs({
      name: 'Reward video',
      format: 'REWARDED',
      category: undefined,
      rewardUnit: 'coin',
      rewardAmount: '10',
      bannerStyle: undefined,
    });
    expect(missingCategory.ok).toBe(true);
    if (missingCategory.ok) {
      expect(missingCategory.value.categoryId).toBeUndefined();
      expect(missingCategory.value.rewardSettings).toEqual({ unitType: 'coin', unitAmount: 10 });
    }

    const missingUnit = validateCreateAdsPlacementGroupArgs({
      name: 'Reward video',
      format: 'REWARDED',
      category: '7',
      rewardUnit: undefined,
      rewardAmount: '10',
      bannerStyle: undefined,
    });
    expect(missingUnit.ok).toBe(false);
    if (!missingUnit.ok) expect(missingUnit.field).toBe('reward-unit');

    const missingAmount = validateCreateAdsPlacementGroupArgs({
      name: 'Reward video',
      format: 'REWARDED',
      category: '7',
      rewardUnit: 'coin',
      rewardAmount: undefined,
      bannerStyle: undefined,
    });
    expect(missingAmount.ok).toBe(false);
    if (!missingAmount.ok) expect(missingAmount.field).toBe('reward-amount');

    const provided = validateCreateAdsPlacementGroupArgs({
      name: 'Reward video',
      format: 'REWARDED',
      category: '7',
      rewardUnit: 'coin',
      rewardAmount: '10',
      bannerStyle: undefined,
    });
    expect(provided.ok).toBe(true);
    if (provided.ok) {
      expect(provided.value).toEqual({
        displayName: 'Reward video',
        adFormat: 'REWARDED',
        categoryId: 7,
        rewardSettings: { unitType: 'coin', unitAmount: 10 },
      });
    }
  });

  it('rejects a non-positive-integer --reward-amount', () => {
    const result = validateCreateAdsPlacementGroupArgs({
      name: 'x',
      format: 'REWARDED',
      category: '7',
      rewardUnit: 'coin',
      rewardAmount: '0',
      bannerStyle: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('reward-amount');
  });

  it('rejects an unknown --banner-style', () => {
    const result = validateCreateAdsPlacementGroupArgs({
      name: 'x',
      format: 'BANNER',
      category: undefined,
      rewardUnit: undefined,
      rewardAmount: undefined,
      bannerStyle: 'CAROUSEL',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('banner-style');
  });

  it('omits categoryId/rewardSettings/adStyles from validated value when not applicable', () => {
    const banner = validateCreateAdsPlacementGroupArgs({
      name: 'x',
      format: 'BANNER',
      category: undefined,
      rewardUnit: undefined,
      rewardAmount: undefined,
      bannerStyle: undefined,
    });
    expect(banner.ok).toBe(true);
    if (banner.ok) {
      expect(banner.value.categoryId).toBeUndefined();
      expect(banner.value.rewardSettings).toBeUndefined();
    }

    const interstitial = validateCreateAdsPlacementGroupArgs({
      name: 'x',
      format: 'INTERSTITIAL',
      category: '1',
      rewardUnit: undefined,
      rewardAmount: undefined,
      bannerStyle: undefined,
    });
    expect(interstitial.ok).toBe(true);
    if (interstitial.ok) {
      expect(interstitial.value.adStyles).toBeUndefined();
      expect(interstitial.value.rewardSettings).toBeUndefined();
    }
  });
});

// The `placement-groups ls` human renderer reads server keys directly, so a
// key rename (or a wrong guess) is invisible to `--json` and shows up only as
// `-` columns. That is exactly how issue #240 stayed latent: the renderer read
// `id`/`status`, the response carries `groupId`/`state`, and our own workflow
// only ever used `--json`. These cases pin the three keys the human path
// depends on. Values here are synthetic — real placement-group identifiers are
// ad monetization data and never enter fixtures (docs/api/_redaction.md).
describe('formatPlacementGroupRow', () => {
  it('reads groupId / name / state — the keys the live response actually uses', () => {
    expect(
      formatPlacementGroupRow({
        groupId: 'test.group.id',
        name: '홈 배너',
        state: 'ENABLED',
      }),
    ).toBe('test.group.id\t홈 배너\tENABLED');
  });

  it('does not fall back to the pre-#240 id/status keys', () => {
    expect(formatPlacementGroupRow({ id: 'wrong', name: 'n', status: 'WRONG' })).toBe('-\tn\t-');
  });

  it('renders a numeric groupId', () => {
    expect(formatPlacementGroupRow({ groupId: 42, name: 'n', state: 'ENABLED' })).toBe(
      '42\tn\tENABLED',
    );
  });

  it('renders - for missing or non-scalar fields rather than throwing', () => {
    expect(formatPlacementGroupRow({})).toBe('-\t-\t-');
    expect(formatPlacementGroupRow({ groupId: null, name: { a: 1 }, state: undefined })).toBe(
      '-\t-\t-',
    );
  });
});
