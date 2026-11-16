/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto';

// Zero-width invisible Unicode characters that render seamlessly without visible glyphs
const ZERO_WIDTH_CHARS = [
  '\u200B', // Zero-width space
  '\u200C', // Zero-width non-joiner
  '\u200D', // Zero-width joiner
  '\uFEFF', // Zero-width no-break space
];

const GREETINGS = ['Hello', 'Hi', 'Greetings', 'Hey'];

/**
 * Generates an invisible entropy signature using zero-width characters.
 * Each character combination corresponds to binary/quaternary representation
 * of a random seed, ensuring the cryptographic hash of the message text
 * is mathematically unique even if the visible text is identical.
 */
export function generateZeroWidthEntropyToken(seed: number | string): string {
  const hash = createHash('sha256').update(String(seed) + Date.now().toString()).digest('hex');
  // Take first 8 hex characters and map each nibble into a zero-width sequence
  let result = '';
  for (let i = 0; i < 8; i++) {
    const val = parseInt(hash[i], 16) % ZERO_WIDTH_CHARS.length;
    result += ZERO_WIDTH_CHARS[val];
  }
  return result;
}

/**
 * Computes a short visible hash fingerprint for debugging and logging.
 */
export function getMessageDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/**
 * Resolves dynamic template variables and injects subtle cryptographic entropy.
 * Supported variables:
 * - {name}: Full name (or fallback)
 * - {first_name}: First word of name
 * - {phone}: Phone number
 * - {number}: Phone number
 * - {date}: Current formatted date
 * - {time}: Current formatted time
 * - {greeting}: Contextual greeting variation
 * - {ref}: Unique reference ID (e.g. #GDG-9104)
 */
export function personalizeMessage(
  template: string,
  contact: { name: string; phone: string },
  index: number
): {
  visibleText: string;
  finalPayload: string;
  digest: string;
} {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const rawName = (contact.name && contact.name.trim()) || 'Member';
  const firstName = rawName.split(' ')[0] || rawName;

  // Pick a semi-random greeting or rotation if {greeting} is used
  const greeting = GREETINGS[index % GREETINGS.length];

  // Unique reference ID
  const ref = `GDG-${(1000 + (index % 9000)).toString(16).toUpperCase()}`;

  let processed = template
    .replace(/\{name\}/gi, rawName)
    .replace(/\{first_name\}/gi, firstName)
    .replace(/\{firstname\}/gi, firstName)
    .replace(/\{phone\}/gi, contact.phone)
    .replace(/\{number\}/gi, contact.phone)
    .replace(/\{date\}/gi, dateStr)
    .replace(/\{time\}/gi, timeStr)
    .replace(/\{greeting\}/gi, greeting)
    .replace(/\{ref\}/gi, ref);

  const visibleText = processed;

  // Generate zero-width payload entropy token
  const entropyToken = generateZeroWidthEntropyToken(`${contact.phone}_${index}_${Date.now()}`);

  // Append invisible token at the end of the message
  const finalPayload = processed + entropyToken;
  const digest = getMessageDigest(finalPayload);

  return {
    visibleText,
    finalPayload,
    digest,
  };
}
