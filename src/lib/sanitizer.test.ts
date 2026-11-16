/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePhoneNumber, parseContacts, maskPhoneNumber, maskName } from './sanitizer.ts';

test('sanitizes 10-digit Indian numbers starting with 6-9 by prepending 91', () => {
  assert.equal(sanitizePhoneNumber('9876543210'), '919876543210');
  assert.equal(sanitizePhoneNumber('8888899999'), '918888899999');
  assert.equal(sanitizePhoneNumber('7000123456'), '917000123456');
  assert.equal(sanitizePhoneNumber('6260112233'), '916260112233');
});

test('handles leading zero trunk prefix for 10-digit Indian numbers', () => {
  assert.equal(sanitizePhoneNumber('09876543210'), '919876543210');
});

test('handles numbers already with +91 or 91 country code', () => {
  assert.equal(sanitizePhoneNumber('+91 98765 43210'), '919876543210');
  assert.equal(sanitizePhoneNumber('919876543210'), '919876543210');
  assert.equal(sanitizePhoneNumber('+91-9876543210'), '919876543210');
});

test('preserves valid international numbers', () => {
  // US number
  assert.equal(sanitizePhoneNumber('+1 415 555 2671'), '14155552671');
  // UK number
  assert.equal(sanitizePhoneNumber('+44 7911 123456'), '447911123456');
});

test('rejects invalid or too short / too long numbers', () => {
  assert.equal(sanitizePhoneNumber('12345'), null);
  assert.equal(sanitizePhoneNumber(''), null);
  assert.equal(sanitizePhoneNumber('abcdefghijk'), null);
  assert.equal(sanitizePhoneNumber('123456789012345678'), null);
});

test('parseContacts parses multiple formats and deduplicates', () => {
  const input = `
    9876543210, Aman Sharma
    Rahul Verma, 8888899999
    9876543210, Aman Duplicate
    +91 70001 23456
    invalid_number_here
  `;

  const result = parseContacts(input);
  assert.equal(result.contacts.length, 3);
  assert.equal(result.duplicatesCount, 1);
  assert.equal(result.invalidCount, 1);

  assert.equal(result.contacts[0].phone, '919876543210');
  assert.equal(result.contacts[0].name, 'Aman Sharma');
  assert.equal(result.contacts[0].jid, '919876543210@s.whatsapp.net');

  assert.equal(result.contacts[1].phone, '918888899999');
  assert.equal(result.contacts[1].name, 'Rahul Verma');

  assert.equal(result.contacts[2].phone, '917000123456');
  assert.equal(result.contacts[2].name, 'Member');
});

test('maskPhoneNumber properly masks digits to protect privacy', () => {
  const masked1 = maskPhoneNumber('919876543210');
  assert.equal(masked1, '+91 9876 •••••');

  const masked2 = maskPhoneNumber('14155552671');
  assert.ok(masked2.includes('•'));
  assert.ok(!masked2.includes('5552671'));
});

test('maskName masks personal names to prevent identity leaks', () => {
  const masked = maskName('Rahul Verma');
  assert.equal(masked, 'R•••• V••••');
  assert.equal(maskName('Member'), 'Member');
});

test('parseContacts parses space-separated phone numbers on a single line', () => {
  const input = '9876543210 9876543211 9876543212 9876543213';
  const result = parseContacts(input);
  assert.equal(result.contacts.length, 4);
  assert.equal(result.duplicatesCount, 0);
  assert.equal(result.invalidCount, 0);
  assert.equal(result.contacts[0].phone, '919876543210');
  assert.equal(result.contacts[1].phone, '919876543211');
  assert.equal(result.contacts[2].phone, '919876543212');
  assert.equal(result.contacts[3].phone, '919876543213');
});

test('parseContacts parses quote-delimited numbers separated by spaces', () => {
  const input = '"9876543210" "9876543211" "9876543212"';
  const result = parseContacts(input);
  assert.equal(result.contacts.length, 3);
  assert.equal(result.contacts[0].phone, '919876543210');
  assert.equal(result.contacts[1].phone, '919876543211');
  assert.equal(result.contacts[2].phone, '919876543212');
});

test('parseContacts parses hundreds of numbers in space-separated format', () => {
  // Generate 250 space-separated numbers
  const count = 250;
  const numbers = Array.from({ length: count }, (_, i) => (9800000000 + i).toString());
  const input = numbers.join(' ');

  const result = parseContacts(input, 800);
  assert.equal(result.contacts.length, 250);
  assert.equal(result.duplicatesCount, 0);
  assert.equal(result.invalidCount, 0);
  assert.equal(result.contacts[0].phone, '919800000000');
  assert.equal(result.contacts[249].phone, '919800000249');
});

test('parseContacts handles space-separated numbers with duplicates and invalid tokens', () => {
  const input = '9876543210 9876543211 9876543210 12345 9876543212';
  const result = parseContacts(input);
  assert.equal(result.contacts.length, 3);
  assert.equal(result.duplicatesCount, 1);
  assert.equal(result.invalidCount, 1);
});

test('parseContacts parses space-separated phone with name without comma', () => {
  const input = '9876543210 Sajal Agrawal\n9876543211 Neha Sharma';
  const result = parseContacts(input);
  assert.equal(result.contacts.length, 2);
  assert.equal(result.contacts[0].phone, '919876543210');
  assert.equal(result.contacts[0].name, 'Sajal Agrawal');
  assert.equal(result.contacts[1].phone, '919876543211');
  assert.equal(result.contacts[1].name, 'Neha Sharma');
});

