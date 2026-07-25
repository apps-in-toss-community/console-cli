import { describe, expect, it } from 'vitest';
import { parseDiscountPoliciesSpec, validateCreateIapProductArgs } from './app-iap.js';

// Field-level rules are pinned against the console SPA's IAPProductEditor
// react-hook-form `rules` (name<=30, description<=45, price 400..1_400_000
// snapped to the nearest 10, renewalCycle/discountPolicies required+
// meaningful iff SUBSCRIPTION and REJECTED otherwise) — see
// src/api/in-app-purchase.ts module comment for the exact source lines this
// mirrors, confirmed via SPA serialization-logic measurement (issue #232,
// 2026-07-25).

const baseValidInput = {
  type: 'CONSUMABLE',
  name: 'coin pack',
  description: '100 coins',
  price: '1000',
  icon: 'https://cdn.example/icon.png',
  minDeployment: '7',
  expose: false,
  renewalCycle: undefined,
  discount: undefined,
};

describe('validateCreateIapProductArgs', () => {
  it('accepts a well-formed CONSUMABLE input', () => {
    const result = validateCreateIapProductArgs(baseValidInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        type: 'CONSUMABLE',
        name: 'coin pack',
        description: '100 coins',
        price: 1000,
        requestedPrice: 1000,
        iconImgUrl: 'https://cdn.example/icon.png',
        minDeploymentId: 7,
        postInspectionStatus: 'INACTIVE',
        discountPolicies: [],
      });
    }
  });

  it('rejects an unknown --type', () => {
    const result = validateCreateIapProductArgs({ ...baseValidInput, type: 'BUNDLE' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('type');
  });

  it('requires --name and rejects >30 chars', () => {
    expect(validateCreateIapProductArgs({ ...baseValidInput, name: undefined }).ok).toBe(false);
    const tooLong = validateCreateIapProductArgs({ ...baseValidInput, name: 'x'.repeat(31) });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.field).toBe('name');
    expect(validateCreateIapProductArgs({ ...baseValidInput, name: 'x'.repeat(30) }).ok).toBe(true);
  });

  it('requires --description and rejects >45 chars', () => {
    expect(validateCreateIapProductArgs({ ...baseValidInput, description: undefined }).ok).toBe(
      false,
    );
    const tooLong = validateCreateIapProductArgs({
      ...baseValidInput,
      description: 'x'.repeat(46),
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.field).toBe('description');
    expect(
      validateCreateIapProductArgs({ ...baseValidInput, description: 'x'.repeat(45) }).ok,
    ).toBe(true);
  });

  it('enforces the 400..1,400,000 KRW price range (post-snap)', () => {
    const tooLow = validateCreateIapProductArgs({ ...baseValidInput, price: '385' });
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) expect(tooLow.field).toBe('price');

    const tooHigh = validateCreateIapProductArgs({ ...baseValidInput, price: '1400005' });
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.field).toBe('price');

    expect(validateCreateIapProductArgs({ ...baseValidInput, price: '400' }).ok).toBe(true);
    expect(validateCreateIapProductArgs({ ...baseValidInput, price: '1400000' }).ok).toBe(true);
  });

  it('rejects a non-integer price', () => {
    const result = validateCreateIapProductArgs({ ...baseValidInput, price: '1000.5' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('price');
  });

  it('snaps a non-multiple-of-10 price to the nearest 10 and reports both values', () => {
    const result = validateCreateIapProductArgs({ ...baseValidInput, price: '1005' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requestedPrice).toBe(1005);
      expect(result.value.price).toBe(1010);
    }
  });

  it('does not report a snap when --price is already a multiple of 10', () => {
    const result = validateCreateIapProductArgs({ ...baseValidInput, price: '1000' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.price).toBe(result.value.requestedPrice);
    }
  });

  it('accepts a below-minimum price that snaps into range (400 boundary)', () => {
    const result = validateCreateIapProductArgs({ ...baseValidInput, price: '396' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requestedPrice).toBe(396);
      expect(result.value.price).toBe(400);
    }
  });

  it('requires --icon', () => {
    const result = validateCreateIapProductArgs({ ...baseValidInput, icon: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('icon');
  });

  it('requires a positive integer --min-deployment', () => {
    expect(validateCreateIapProductArgs({ ...baseValidInput, minDeployment: undefined }).ok).toBe(
      false,
    );
    const zero = validateCreateIapProductArgs({ ...baseValidInput, minDeployment: '0' });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.field).toBe('min-deployment');
  });

  it('maps --expose to postInspectionStatus ACTIVE, default INACTIVE', () => {
    const inactive = validateCreateIapProductArgs(baseValidInput);
    expect(inactive.ok).toBe(true);
    if (inactive.ok) expect(inactive.value.postInspectionStatus).toBe('INACTIVE');

    const active = validateCreateIapProductArgs({ ...baseValidInput, expose: true });
    expect(active.ok).toBe(true);
    if (active.ok) expect(active.value.postInspectionStatus).toBe('ACTIVE');
  });

  it('requires --renewal-cycle when --type is SUBSCRIPTION', () => {
    const missing = validateCreateIapProductArgs({
      ...baseValidInput,
      type: 'SUBSCRIPTION',
      renewalCycle: undefined,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.field).toBe('renewal-cycle');

    const provided = validateCreateIapProductArgs({
      ...baseValidInput,
      type: 'SUBSCRIPTION',
      renewalCycle: 'MONTHLY',
    });
    expect(provided.ok).toBe(true);
    if (provided.ok) expect(provided.value.renewalCycle).toBe('MONTHLY');
  });

  it('rejects --renewal-cycle for non-SUBSCRIPTION types instead of silently dropping it', () => {
    const result = validateCreateIapProductArgs({
      ...baseValidInput,
      type: 'CONSUMABLE',
      renewalCycle: 'MONTHLY',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe('renewal-cycle');
      expect(result.message).toContain('only valid when --type is SUBSCRIPTION');
    }
  });

  it('rejects an unknown --renewal-cycle for SUBSCRIPTION', () => {
    const result = validateCreateIapProductArgs({
      ...baseValidInput,
      type: 'SUBSCRIPTION',
      renewalCycle: 'DAILY',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('renewal-cycle');
  });

  it('omits renewalCycle from the validated value for non-subscription types', () => {
    const result = validateCreateIapProductArgs(baseValidInput);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.renewalCycle).toBeUndefined();
  });

  it('forces discountPolicies to [] for non-SUBSCRIPTION types', () => {
    const result = validateCreateIapProductArgs(baseValidInput);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.discountPolicies).toEqual([]);
  });

  it('rejects --discount for non-SUBSCRIPTION types instead of silently dropping it', () => {
    const result = validateCreateIapProductArgs({
      ...baseValidInput,
      type: 'CONSUMABLE',
      discount: 'type=FREE_TRIAL,period=ONE_WEEK',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe('discount');
      expect(result.message).toContain('only valid when --type is SUBSCRIPTION');
    }
  });

  it('parses --discount into discountPolicies for SUBSCRIPTION', () => {
    const result = validateCreateIapProductArgs({
      ...baseValidInput,
      type: 'SUBSCRIPTION',
      renewalCycle: 'MONTHLY',
      discount:
        'type=FREE_TRIAL,period=ONE_WEEK;type=RETURNING,durationMonths=1,discountedNetPrice=2000',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.discountPolicies).toEqual([
        { discountType: 'FREE_TRIAL', period: 'ONE_WEEK' },
        { discountType: 'RETURNING', durationMonths: 1, discountedNetPrice: 2000 },
      ]);
    }
  });

  it('propagates a --discount parse error with the discount field', () => {
    const result = validateCreateIapProductArgs({
      ...baseValidInput,
      type: 'SUBSCRIPTION',
      renewalCycle: 'MONTHLY',
      discount: 'type=BOGUS',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('discount');
  });

  it('SUBSCRIPTION without --discount still yields discountPolicies: []', () => {
    const result = validateCreateIapProductArgs({
      ...baseValidInput,
      type: 'SUBSCRIPTION',
      renewalCycle: 'YEARLY',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.discountPolicies).toEqual([]);
  });
});

describe('parseDiscountPoliciesSpec', () => {
  it('parses a single FREE_TRIAL entry', () => {
    const result = parseDiscountPoliciesSpec('type=FREE_TRIAL,period=THREE_DAYS');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ discountType: 'FREE_TRIAL', period: 'THREE_DAYS' }]);
    }
  });

  it('parses multiple ;-separated entries', () => {
    const result = parseDiscountPoliciesSpec(
      'type=FREE_TRIAL,period=ONE_MONTH;type=NEW_SUBSCRIPTION,durationMonths=3,discountedNetPrice=4000',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { discountType: 'FREE_TRIAL', period: 'ONE_MONTH' },
        { discountType: 'NEW_SUBSCRIPTION', durationMonths: 3, discountedNetPrice: 4000 },
      ]);
    }
  });

  it('rejects an unknown discount type', () => {
    const result = parseDiscountPoliciesSpec('type=BOGUS');
    expect(result.ok).toBe(false);
  });

  it('rejects FREE_TRIAL with an invalid period', () => {
    const result = parseDiscountPoliciesSpec('type=FREE_TRIAL,period=TEN_DAYS');
    expect(result.ok).toBe(false);
  });

  it('rejects FREE_TRIAL missing period', () => {
    const result = parseDiscountPoliciesSpec('type=FREE_TRIAL');
    expect(result.ok).toBe(false);
  });

  it('rejects NEW_SUBSCRIPTION missing durationMonths/discountedNetPrice', () => {
    const result = parseDiscountPoliciesSpec('type=NEW_SUBSCRIPTION,durationMonths=3');
    expect(result.ok).toBe(false);
  });

  it('rejects durationMonths above 12', () => {
    const result = parseDiscountPoliciesSpec(
      'type=RETURNING,durationMonths=13,discountedNetPrice=1000',
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a non-positive discountedNetPrice', () => {
    const result = parseDiscountPoliciesSpec(
      'type=RETURNING,durationMonths=1,discountedNetPrice=0',
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a duplicate discountType across entries', () => {
    const result = parseDiscountPoliciesSpec(
      'type=FREE_TRIAL,period=ONE_WEEK;type=FREE_TRIAL,period=TWO_WEEKS',
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed key=value pair', () => {
    const result = parseDiscountPoliciesSpec('type=FREE_TRIAL,periodONE_WEEK');
    expect(result.ok).toBe(false);
  });

  it('rejects extra unrecognized keys for FREE_TRIAL', () => {
    const result = parseDiscountPoliciesSpec('type=FREE_TRIAL,period=ONE_WEEK,durationMonths=1');
    expect(result.ok).toBe(false);
  });

  it('rejects an empty spec', () => {
    const result = parseDiscountPoliciesSpec('  ; ;  ');
    expect(result.ok).toBe(false);
  });
});
