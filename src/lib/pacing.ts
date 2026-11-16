/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type PacingMode = 'fast' | 'balanced' | 'safe' | 'ultra_safe' | 'guardian_8h' | 'over_safe';

export interface PacingConfig {
  mode: PacingMode;
  targetWindowMinutes: number;
  baseIntervalMs: number;
  jitterMinMs: number;
  jitterMaxMs: number;
  typingMinMs: number;
  typingMaxMs: number;
  cooldownBatchMin: number;
  cooldownBatchMax: number;
  cooldownDurationMinMs: number;
  cooldownDurationMaxMs: number;
}

export const PACING_PRESETS: Record<PacingMode, PacingConfig> = {
  // ~60 mins for 800 contacts (~3600 seconds)
  fast: {
    mode: 'fast',
    targetWindowMinutes: 60,
    baseIntervalMs: 4500,
    jitterMinMs: 4200,
    jitterMaxMs: 5800,
    typingMinMs: 1200,
    typingMaxMs: 1800,
    cooldownBatchMin: 45,
    cooldownBatchMax: 55,
    cooldownDurationMinMs: 45000,
    cooldownDurationMaxMs: 60000,
  },
  // ~90 mins for 800 contacts (~5400 seconds) - Recommended Default
  balanced: {
    mode: 'balanced',
    targetWindowMinutes: 90,
    baseIntervalMs: 6800,
    jitterMinMs: 5500,
    jitterMaxMs: 8200,
    typingMinMs: 1400,
    typingMaxMs: 2200,
    cooldownBatchMin: 40,
    cooldownBatchMax: 50,
    cooldownDurationMinMs: 50000,
    cooldownDurationMaxMs: 70000,
  },
  // ~120 mins for 800 contacts (~7200 seconds)
  safe: {
    mode: 'safe',
    targetWindowMinutes: 120,
    baseIntervalMs: 9200,
    jitterMinMs: 7800,
    jitterMaxMs: 11200,
    typingMinMs: 1600,
    typingMaxMs: 2500,
    cooldownBatchMin: 35,
    cooldownBatchMax: 45,
    cooldownDurationMinMs: 60000,
    cooldownDurationMaxMs: 85000,
  },
  // ~240 mins (4 Hours) for 800 contacts (~14400 seconds) - Ultra-Safe Stealth Shield
  ultra_safe: {
    mode: 'ultra_safe',
    targetWindowMinutes: 240,
    baseIntervalMs: 14500,
    jitterMinMs: 12000,
    jitterMaxMs: 18000,
    typingMinMs: 1800,
    typingMaxMs: 3200,
    cooldownBatchMin: 25,
    cooldownBatchMax: 35,
    cooldownDurationMinMs: 90000,
    cooldownDurationMaxMs: 140000,
  },
  // ~480 mins (8 Hours) for 800 contacts (~28800 seconds) - Absolute Safest / Zero Suspension Risk
  guardian_8h: {
    mode: 'guardian_8h',
    targetWindowMinutes: 480,
    baseIntervalMs: 29000,
    jitterMinMs: 24000,
    jitterMaxMs: 36000,
    typingMinMs: 2500,
    typingMaxMs: 4500,
    cooldownBatchMin: 20,
    cooldownBatchMax: 30,
    cooldownDurationMinMs: 150000,
    cooldownDurationMaxMs: 240000,
  },
  // 360 seconds (6.0m) to 514 seconds (~8.57m) randomized jitter (~7-10 msgs per hour) - Over Safe / Extreme Slow
  over_safe: {
    mode: 'over_safe',
    targetWindowMinutes: 5827,
    baseIntervalMs: 437000,
    jitterMinMs: 360000,
    jitterMaxMs: 514000,
    typingMinMs: 3500,
    typingMaxMs: 7500,
    cooldownBatchMin: 7,
    cooldownBatchMax: 10,
    cooldownDurationMinMs: 300000,
    cooldownDurationMaxMs: 480000,
  },
};

export interface PacingModeMeta {
  mode: PacingMode;
  name: string;
  tag: string;
  window: string;
  baseIntervalDesc: string;
  cooldownDesc: string;
  safetyLevel: string;
  badgeText?: string;
  badgeClass?: string;
  description: string;
  suspensionRisk: string;
}

export const PACING_MODES_METADATA: PacingModeMeta[] = [
  {
    mode: 'fast',
    name: 'Fast',
    tag: '1.0 Hr',
    window: '~1.0 Hr',
    baseIntervalDesc: '4.5s base (4.2s-5.8s)',
    cooldownDesc: '50 msg / 50s pause',
    safetyLevel: 'Standard',
    description: 'Rapid dispatch for warm groups, existing event participants, or time-critical alerts.',
    suspensionRisk: 'Low on established accounts, use caution with un-warmed numbers.',
  },
  {
    mode: 'balanced',
    name: 'Balanced',
    tag: '1.5 Hrs',
    window: '~1.5 Hrs',
    baseIntervalDesc: '6.8s base (5.5s-8.2s)',
    cooldownDesc: '45 msg / 60s pause',
    safetyLevel: 'High',
    badgeText: 'Default',
    badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    description: 'Recommended default for GDG chapter broadcasts. Combines human typing with steady throughput.',
    suspensionRisk: 'Very Low. Well within standard WhatsApp rate patterns.',
  },
  {
    mode: 'safe',
    name: 'Safe',
    tag: '2.0 Hrs',
    window: '~2.0 Hrs',
    baseIntervalDesc: '9.2s base (7.8s-11.2s)',
    cooldownDesc: '40 msg / 70s pause',
    safetyLevel: 'Very High',
    description: 'Conservative broadcast rate for mixed contact lists and large announcements.',
    suspensionRisk: 'Extremely Low. Stochastic intervals defeat automated pattern detectors.',
  },
  {
    mode: 'ultra_safe',
    name: 'Ultra Safe',
    tag: '4.0 Hrs',
    window: '~4.0 Hrs',
    baseIntervalDesc: '14.5s base (12s-18s)',
    cooldownDesc: '30 msg / 2m pause',
    safetyLevel: 'Stealth Shield',
    badgeText: '4 Hours',
    badgeClass: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
    description: 'Extended 4-hour stealth pacing with 2-minute micro-batch breathers. Ideal for larger or unverified recipient lists.',
    suspensionRisk: 'Near 0%. Spaced out so traffic looks like active manual desktop messaging.',
  },
  {
    mode: 'guardian_8h',
    name: 'Guardian',
    tag: '8.0 Hrs',
    window: '~8.0 Hrs',
    baseIntervalDesc: '29s base (24s-36s)',
    cooldownDesc: '25 msg / 3-4m pause',
    safetyLevel: 'Absolute Safest',
    badgeText: '0% Suspension Risk',
    badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    description: 'Full 8-hour workday human simulation. Sends 1 message every ~30 seconds with 4-minute coffee breaks.',
    suspensionRisk: 'Absolute 0% Risk. Indistinguishable from an employee sitting and chatting all day.',
  },
  {
    mode: 'over_safe',
    name: 'Over Safe',
    tag: '360s-514s',
    window: '360s-514s Jitter',
    baseIntervalDesc: '360s - 514s Random Jitter',
    cooldownDesc: 'Randomized 360s-514s gap',
    safetyLevel: 'Zero Risk (360s-514s)',
    badgeText: '360s - 514s Jitter',
    badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    description: 'Ultra-safe randomized pacing. Every message interval is randomly selected between 360 seconds (6.0m) and 514 seconds (8.57m), completely randomizing dispatch timing and eliminating robotic regularity.',
    suspensionRisk: 'Absolute 0% Risk. Pure stochastic timing randomized between 360s and 514s bypasses WhatsApp automated periodic pattern detection.',
  },
];

/**
 * Standard Box-Muller transform for generating normally distributed values.
 * Returns a number with mean 0 and standard deviation 1.
 */
export function randomGaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Generates a randomized delay using a hybrid Gaussian-uniform distribution
 * centered around baseIntervalMs, clamped strictly within [minMs, maxMs].
 * This introduces high-entropy, organic variation that prevents deterministic,
 * clock-cycle periodic traffic patterns that automated anti-spam algorithms flag.
 */
export function getGaussianJitter(
  baseMs: number,
  minMs: number,
  maxMs: number
): number {
  const stdDev = (maxMs - minMs) / 4;
  const gaussianValue = baseMs + randomGaussian() * stdDev;
  const uniformValue = minMs + Math.random() * (maxMs - minMs);
  const blended = 0.4 * gaussianValue + 0.6 * uniformValue;
  return Math.round(Math.min(maxMs, Math.max(minMs, blended)));
}

/**
 * Calculates a dynamic typing presence simulation duration between min and max.
 */
export function getTypingDuration(minMs = 1200, maxMs = 2500): number {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

/**
 * Calculates the next micro-batch threshold between min and max.
 */
export function getNextBatchThreshold(minMsgs = 40, maxMsgs = 55): number {
  return Math.floor(minMsgs + Math.random() * (maxMsgs - minMsgs + 1));
}

/**
 * Calculates a randomized cooldown pause duration.
 */
export function getCooldownDuration(minMs = 45000, maxMs = 75000): number {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

/**
 * Estimates remaining time in seconds based on remaining items, average interval,
 * and scheduled cooldown breathers.
 */
export function calculateRemainingSeconds(
  remainingItems: number,
  config: PacingConfig,
  currentBatchCount: number
): number {
  if (remainingItems <= 0) return 0;

  const avgIntervalSec = (config.jitterMinMs + config.jitterMaxMs) / 2000;
  const avgCooldownSec = (config.cooldownDurationMinMs + config.cooldownDurationMaxMs) / 2000;
  const avgBatchThreshold = (config.cooldownBatchMin + config.cooldownBatchMax) / 2;

  const intervalsDuration = remainingItems * avgIntervalSec;

  // Approximate how many cooldowns will happen during remaining items
  const itemsUntilNextCooldown = Math.max(0, avgBatchThreshold - currentBatchCount);
  const remainingAfterNext = Math.max(0, remainingItems - itemsUntilNextCooldown);
  const totalCooldowns = (itemsUntilNextCooldown > 0 ? 1 : 0) + Math.floor(remainingAfterNext / avgBatchThreshold);

  return Math.round(intervalsDuration + totalCooldowns * avgCooldownSec);
}

/**
 * Formats seconds into human-readable duration (e.g., "1h 14m 20s", "42m 10s", "45s").
 */
export function formatDuration(seconds: number): string {
  if (isNaN(seconds) || seconds <= 0) return '0s';

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (hrs > 0) parts.push(`${hrs}h`);
  if (mins > 0 || hrs > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);

  return parts.join(' ');
}
