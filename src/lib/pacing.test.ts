/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PACING_PRESETS,
  getGaussianJitter,
  getTypingDuration,
  getNextBatchThreshold,
  getCooldownDuration,
  calculateRemainingSeconds,
  formatDuration,
} from './pacing.ts';

test('PACING_PRESETS have valid boundaries and ratios', () => {
  for (const key of ['fast', 'balanced', 'safe', 'ultra_safe', 'guardian_8h', 'over_safe'] as const) {
    const preset = PACING_PRESETS[key];
    assert.ok(preset.baseIntervalMs >= 4000);
    assert.ok(preset.jitterMinMs < preset.baseIntervalMs);
    assert.ok(preset.jitterMaxMs > preset.baseIntervalMs);
    assert.ok(preset.cooldownDurationMinMs >= 45000);
    assert.ok(preset.cooldownBatchMin >= 5);
  }
  // Verify ultra_safe and guardian_8h specific boundaries
  assert.equal(PACING_PRESETS.ultra_safe.targetWindowMinutes, 240);
  assert.equal(PACING_PRESETS.guardian_8h.targetWindowMinutes, 480);
  assert.ok(PACING_PRESETS.guardian_8h.baseIntervalMs >= 25000);

  // Verify over_safe sends messages randomly between 360 seconds and 514 seconds
  const overSafe = PACING_PRESETS.over_safe;
  assert.equal(overSafe.jitterMinMs, 360000);
  assert.equal(overSafe.jitterMaxMs, 514000);
  assert.ok(overSafe.baseIntervalMs >= 360000 && overSafe.baseIntervalMs <= 514000);
  const avgIntervalSec = (overSafe.jitterMinMs + overSafe.jitterMaxMs) / 2000;
  const msgsPerHour = 3600 / avgIntervalSec;
  assert.ok(
    msgsPerHour >= 7.0 && msgsPerHour <= 10.0,
    `Over Safe should deliver between 7 and 10 msgs/hour, calculated: ${msgsPerHour.toFixed(2)}`
  );
});

test('getGaussianJitter outputs values strictly within [min, max]', () => {
  const min = 5500;
  const max = 8200;
  const base = 6800;

  for (let i = 0; i < 100; i++) {
    const val = getGaussianJitter(base, min, max);
    assert.ok(val >= min, `Value ${val} should be >= ${min}`);
    assert.ok(val <= max, `Value ${val} should be <= ${max}`);
  }
});

test('getTypingDuration outputs realistic human typing duration', () => {
  for (let i = 0; i < 50; i++) {
    const typing = getTypingDuration(1200, 2500);
    assert.ok(typing >= 1200);
    assert.ok(typing <= 2500);
  }
});

test('getNextBatchThreshold produces randomized thresholds between 40 and 55', () => {
  for (let i = 0; i < 50; i++) {
    const threshold = getNextBatchThreshold(40, 55);
    assert.ok(threshold >= 40 && threshold <= 55);
  }
});

test('calculateRemainingSeconds and formatDuration properly estimate time', () => {
  const preset = PACING_PRESETS.balanced;
  const etaSec = calculateRemainingSeconds(100, preset, 10);
  assert.ok(etaSec > 500 && etaSec < 1500, `ETA should be realistic: ${etaSec}`);

  // Test 4-hour ultra_safe mode for 800 contacts
  const ultraPreset = PACING_PRESETS.ultra_safe;
  const ultraEta = calculateRemainingSeconds(800, ultraPreset, 0);
  // ~14400s (4 hours) with variance for cooldowns
  assert.ok(ultraEta >= 12000 && ultraEta <= 18000, `4h ETA should be ~4h: ${ultraEta}`);
  assert.ok(formatDuration(ultraEta).includes('h'), '4h ETA should include hours in formatting');

  // Test 8-hour guardian_8h mode for 800 contacts
  const guardianPreset = PACING_PRESETS.guardian_8h;
  const guardianEta = calculateRemainingSeconds(800, guardianPreset, 0);
  // ~28800s (8 hours) with variance for cooldowns
  assert.ok(guardianEta >= 24000 && guardianEta <= 35000, `8h ETA should be ~8h: ${guardianEta}`);
  assert.ok(formatDuration(guardianEta).includes('h'), '8h ETA should include hours in formatting');

  // Test over_safe mode: 7 messages should take ~1 hour (3600s)
  const overSafePreset = PACING_PRESETS.over_safe;
  const overSafe7Eta = calculateRemainingSeconds(7, overSafePreset, 0);
  // 7 messages * 437s average = 3059s + cooldown = ~3449s (~57m, approx 1 hour)
  assert.ok(overSafe7Eta >= 3000 && overSafe7Eta <= 5000, `7 messages in over_safe should take ~1 hour: ${overSafe7Eta}`);
  assert.ok(formatDuration(overSafe7Eta).includes('h') || formatDuration(overSafe7Eta).includes('57m') || formatDuration(overSafe7Eta).includes('m'), 'over_safe 7 msgs ETA should format duration properly');

  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(125), '2m 5s');
  assert.equal(formatDuration(3665), '1h 1m 5s');
  assert.equal(formatDuration(28800), '8h 0m 0s');
});

test('over_safe random jitter strictly generates delays between 360s and 514s with natural variance', () => {
  const overSafe = PACING_PRESETS.over_safe;
  const values: number[] = [];

  for (let i = 0; i < 100; i++) {
    const val = getGaussianJitter(overSafe.baseIntervalMs, overSafe.jitterMinMs, overSafe.jitterMaxMs);
    assert.ok(val >= 360000, `Jitter ${val}ms must be >= 360000ms (360 seconds)`);
    assert.ok(val <= 514000, `Jitter ${val}ms must be <= 514000ms (514 seconds)`);
    values.push(val);
  }

  // Verify high natural entropy (completely eliminates robotic exact-interval signatures)
  const uniqueValues = new Set(values);
  assert.ok(uniqueValues.size >= 75, `Expected high entropy across 100 samples, got ${uniqueValues.size} unique intervals`);
  const minObserved = Math.min(...values);
  const maxObserved = Math.max(...values);
  assert.ok(maxObserved - minObserved >= 100000, `Expected wide spread between 360s and 514s, spread was ${maxObserved - minObserved}ms`);
});
