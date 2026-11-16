/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateZeroWidthEntropyToken,
  getMessageDigest,
  personalizeMessage,
} from './entropy.ts';

test('generateZeroWidthEntropyToken generates invisible zero-width sequences', () => {
  const token1 = generateZeroWidthEntropyToken('seed_1');
  const token2 = generateZeroWidthEntropyToken('seed_2');

  assert.ok(token1.length > 0);
  assert.ok(token2.length > 0);

  // Check that all characters are zero-width unicode
  const zeroWidthRegex = /^[\u200B\u200C\u200D\uFEFF]+$/;
  assert.ok(zeroWidthRegex.test(token1), 'Token should consist only of zero-width characters');
  assert.ok(zeroWidthRegex.test(token2), 'Token should consist only of zero-width characters');
});

test('personalizeMessage resolves variables and creates unique payload hashes', () => {
  const template = 'Hello {name}! Your registered number is {phone}.';
  const contact1 = { name: 'Priya Sharma', phone: '919876543210' };
  const contact2 = { name: 'Priya Sharma', phone: '919876543210' }; // same name/phone, different index

  const res1 = personalizeMessage(template, contact1, 0);
  const res2 = personalizeMessage(template, contact2, 1);

  assert.ok(res1.visibleText.includes('Priya Sharma'));
  assert.ok(res1.visibleText.includes('919876543210'));

  // The visible text should be identical when no dynamic index tokens like {ref} are used
  assert.equal(res1.visibleText, res2.visibleText);

  // But the digests and final payloads should differ because of entropy injection
  assert.notEqual(res1.finalPayload, res2.finalPayload);
  assert.notEqual(res1.digest, res2.digest);
});

test('personalizeMessage resolves dynamic ref tag uniquely', () => {
  const template = 'Ref: {ref}';
  const contact = { name: 'Priya', phone: '919876543210' };
  const r0 = personalizeMessage(template, contact, 0);
  const r1 = personalizeMessage(template, contact, 1);
  assert.notEqual(r0.visibleText, r1.visibleText);
});

test('getMessageDigest outputs consistent 8-character hex digests', () => {
  const d1 = getMessageDigest('test content 1');
  const d2 = getMessageDigest('test content 2');

  assert.equal(d1.length, 8);
  assert.equal(d2.length, 8);
  assert.notEqual(d1, d2);
});
