'use strict';
/**
 * Tests for DataLayer.buildFuturesPlan() (apps/frontend/src/data.js).
 * Run with: node --test   (from apps/frontend, or `pnpm --filter frontend test`)
 * No dependencies -- uses Node's built-in test runner + assert.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const DataLayer = require('./data.js');

const barrierCurves = {
  // NOCTUA touch-probability curve, one entry per barrier level.
  dn: [
    { pct: -1, touch_prob: 0.50 },
    { pct: -2, touch_prob: 0.35 },
    { pct: -3, touch_prob: 0.20 },
  ],
  up: [
    { pct: 1, touch_prob: 0.30 },
    { pct: 2, touch_prob: 0.20 },
    { pct: 3, touch_prob: 0.10 },
  ],
};

test('rejects when price is missing', () => {
  const plan = DataLayer.buildFuturesPlan({ direction: 'long' });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /price/i);
});

test('rejects when direction is not "long" or "short"', () => {
  const plan = DataLayer.buildFuturesPlan({ price: 60000, direction: 'sideways' });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /"long"\/"short"/);
});

test('rejects when direction is missing entirely', () => {
  const plan = DataLayer.buildFuturesPlan({ price: 60000 });
  assert.equal(plan.ok, false);
});

test('long: picks SL from the dn side and TP from the up side, closest to the touch-prob targets', () => {
  const plan = DataLayer.buildFuturesPlan({
    price: 60000,
    direction: 'long',
    BGTC: { barrier_curves: barrierCurves, p_vol_amplify: 0.5 },
    slTouchTarget: 0.35,
    tpTouchTarget: 0.20,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.usedBarrierCurves, true);
  // Exact match in the fixture: dn pct=-2 has touch_prob 0.35, up pct=2 has touch_prob 0.20.
  assert.equal(plan.stopDistancePct, 2);
  assert.equal(plan.tpDistancePct, 2);
  assert.equal(plan.slTouchProb, 0.35);
  assert.equal(plan.tpTouchProb, 0.20);
  // Long: SL below entry, TP above entry.
  assert.ok(plan.stopLoss < plan.entryPrice);
  assert.ok(plan.takeProfit > plan.entryPrice);
});

test('short: mirrors sides -- SL from the up side, TP from the dn side', () => {
  const plan = DataLayer.buildFuturesPlan({
    price: 60000,
    direction: 'short',
    BGTC: { barrier_curves: barrierCurves, p_vol_amplify: 0.5 },
    slTouchTarget: 0.20,
    tpTouchTarget: 0.35,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.stopDistancePct, 2);   // up pct=2, touch_prob 0.20
  assert.equal(plan.tpDistancePct, 2);     // dn pct=-2, touch_prob 0.35
  // Short: SL above entry, TP below entry.
  assert.ok(plan.stopLoss > plan.entryPrice);
  assert.ok(plan.takeProfit < plan.entryPrice);
});

test('falls back to an HV20 multiple when barrier_curves is absent, and warns about it', () => {
  const plan = DataLayer.buildFuturesPlan({
    price: 60000,
    direction: 'long',
    hv20: { oneDay: 3 },
    BGTC: { p_vol_amplify: 0.5 },   // no barrier_curves
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.usedBarrierCurves, false);
  assert.equal(plan.stopDistancePct, 3);     // 1x HV20 daily move
  assert.equal(plan.tpDistancePct, 4.5);     // 1.5x HV20 daily move
  assert.equal(plan.slTouchProb, null);
  assert.ok(plan.warnings.some(w => /barrier_curves not available/.test(w)));
});

test('warns when risk/reward is below minRR', () => {
  const plan = DataLayer.buildFuturesPlan({
    price: 60000,
    direction: 'long',
    BGTC: { barrier_curves: barrierCurves, p_vol_amplify: 0.5 },
    slTouchTarget: 0.35,   // dn pct=-2
    tpTouchTarget: 0.20,   // up pct=2 -> RR = 2/2 = 1.0
    minRR: 1.3,
  });
  assert.equal(plan.riskRewardRatio, 1);
  assert.ok(plan.warnings.some(w => /Risk\/reward/.test(w)));
});

test('shrinks size multiplier as p_vol_amplify rises', () => {
  const low = DataLayer.buildFuturesPlan({
    price: 60000, direction: 'long', hv20: { oneDay: 2 },
    BGTC: { p_vol_amplify: 0 },
  });
  const high = DataLayer.buildFuturesPlan({
    price: 60000, direction: 'long', hv20: { oneDay: 2 },
    BGTC: { p_vol_amplify: 1 },
  });
  assert.equal(low.sizeMultiplier, 1);     // 1 - 0*0.6 = 1
  assert.equal(high.sizeMultiplier, 0.4);  // 1 - 1*0.6 = 0.4
  assert.ok(high.sizeMultiplier < low.sizeMultiplier);
});

test('never shrinks the vol-based size multiplier below the 0.25 floor', () => {
  const plan = DataLayer.buildFuturesPlan({
    price: 60000, direction: 'long', hv20: { oneDay: 2 },
    BGTC: { p_vol_amplify: 2 },   // out-of-range input, should still clamp
  });
  assert.ok(plan.sizeMultiplier >= 0.25);
});

test('halves size and warns when funding is extreme in the same direction as the trade', () => {
  const longExtreme = DataLayer.buildFuturesPlan({
    price: 60000, direction: 'long', hv20: { oneDay: 2 },
    BGTC: { p_vol_amplify: 0 },
    funding: { flag: 'long-extreme', ratePct: 0.05 },
  });
  assert.equal(longExtreme.sizeMultiplier, 0.5);
  assert.ok(longExtreme.warnings.some(w => /extremely positive/.test(w)));

  const shortExtreme = DataLayer.buildFuturesPlan({
    price: 60000, direction: 'short', hv20: { oneDay: 2 },
    BGTC: { p_vol_amplify: 0 },
    funding: { flag: 'short-extreme', ratePct: -0.05 },
  });
  assert.equal(shortExtreme.sizeMultiplier, 0.5);
  assert.ok(shortExtreme.warnings.some(w => /extremely negative/.test(w)));
});

test('does not penalise size when funding is extreme against the trade direction', () => {
  // Short-extreme funding while going LONG should not trigger the long-side penalty.
  const plan = DataLayer.buildFuturesPlan({
    price: 60000, direction: 'long', hv20: { oneDay: 2 },
    BGTC: { p_vol_amplify: 0 },
    funding: { flag: 'short-extreme', ratePct: -0.05 },
  });
  assert.equal(plan.sizeMultiplier, 1);
});

test('computes riskAmount/positionNotional only when accountEquity is supplied', () => {
  const withEquity = DataLayer.buildFuturesPlan({
    price: 60000, direction: 'long', hv20: { oneDay: 2 },
    BGTC: { p_vol_amplify: 0 },
    accountEquity: 10000, riskPct: 1,
  });
  assert.equal(withEquity.stopDistancePct, 2);
  // riskAmount = 10000 * 1% * sizeMultiplier(1) = 100
  assert.equal(withEquity.riskAmount, 100);
  // positionNotional = riskAmount / (stopDistancePct/100) = 100 / 0.02 = 5000
  assert.equal(withEquity.positionNotional, 5000);

  const withoutEquity = DataLayer.buildFuturesPlan({
    price: 60000, direction: 'long', hv20: { oneDay: 2 },
    BGTC: { p_vol_amplify: 0 },
  });
  assert.equal(withoutEquity.riskAmount, null);
  assert.equal(withoutEquity.positionNotional, null);
});

test('accepts legacy volAmp (0-100) when p_vol_amplify is not present', () => {
  const plan = DataLayer.buildFuturesPlan({
    price: 60000, direction: 'long', hv20: { oneDay: 2 },
    BGTC: { volAmp: 100 },   // legacy 0-100 scale -> should behave like p_vol_amplify: 1
  });
  assert.equal(plan.pVolAmplify, 1);
  assert.equal(plan.sizeMultiplier, 0.4);
});

test('defaults p_vol_amplify to 0.5 when BGTC payload is entirely absent', () => {
  const plan = DataLayer.buildFuturesPlan({
    price: 60000, direction: 'long', hv20: { oneDay: 2 },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.pVolAmplify, 0.5);
});
