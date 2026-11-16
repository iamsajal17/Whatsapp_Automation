/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DispatchQueue, WASocketLike } from './queue.ts';
import { ContactItem } from './sanitizer.ts';

class MockWASocket implements WASocketLike {
  public sentMessages: Array<{ jid: string; text: string }> = [];
  public presenceEvents: Array<{ type: string; jid?: string }> = [];

  async onWhatsApp(jid: string) {
    // Simulate one invalid number
    if (jid.includes('0000000000')) {
      return [{ exists: false, jid }];
    }
    return [{ exists: true, jid }];
  }

  async sendPresenceUpdate(type: 'composing' | 'paused' | 'available' | 'unavailable', toJid?: string) {
    this.presenceEvents.push({ type, jid: toJid });
  }

  async sendMessage(jid: string, content: { text: string }) {
    this.sentMessages.push({ jid, text: content.text });
    return { status: 200 };
  }
}

test('DispatchQueue initialization and state inspection', () => {
  const mockSocket = new MockWASocket();
  const queue = new DispatchQueue(() => mockSocket);

  const state = queue.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.sent, 0);
  assert.equal(state.total, 0);
});

test('DispatchQueue rejects start when WhatsApp is not connected', async () => {
  const queue = new DispatchQueue(() => null);
  const contacts: ContactItem[] = [
    { raw: '9876543210', phone: '919876543210', name: 'User 1', jid: '919876543210@s.whatsapp.net' },
  ];

  const result = await queue.start(contacts, 'Test message', 'fast');
  assert.equal(result.success, false);
  assert.ok(result.error?.includes('not connected'));
});

test('DispatchQueue handles abort gracefully', async () => {
  const mockSocket = new MockWASocket();
  const queue = new DispatchQueue(() => mockSocket);

  const contacts: ContactItem[] = [
    { raw: '9876543210', phone: '919876543210', name: 'User 1', jid: '919876543210@s.whatsapp.net' },
    { raw: '9876543211', phone: '919876543211', name: 'User 2', jid: '919876543211@s.whatsapp.net' },
  ];

  await queue.start(contacts, 'Test message', 'fast');
  assert.equal(queue.getState().status, 'running');

  const abortRes = queue.abort();
  assert.equal(abortRes.success, true);
  assert.equal(queue.getState().status, 'aborted');

  queue.reset();
  assert.equal(queue.getState().status, 'idle');
  assert.equal(queue.getState().logs.length, 0);
});

test('DispatchQueue clearLogs wipes logs and preserves privacy', async () => {
  const mockSocket = new MockWASocket();
  const queue = new DispatchQueue(() => mockSocket);

  const contacts: ContactItem[] = [
    { raw: '9876543210', phone: '919876543210', name: 'Aman Sharma', jid: '919876543210@s.whatsapp.net' },
  ];

  await queue.start(contacts, 'Hello', 'fast');
  assert.ok(queue.getState().logs.length > 0);

  // Check that logs do not contain raw unmasked phone numbers
  const logMessages = queue.getState().logs.map(l => l.message).join(' ');
  assert.ok(!logMessages.includes('919876543210'));

  // Test clearLogs
  queue.clearLogs();
  assert.equal(queue.getState().logs.length, 0);
});

test('DispatchQueue instantly interrupts active sleep and halts further dispatch', async () => {
  const mockSocket = new MockWASocket();
  const queue = new DispatchQueue(() => mockSocket);

  const contacts: ContactItem[] = [
    { raw: '9876543210', phone: '919876543210', name: 'User 1', jid: '919876543210@s.whatsapp.net' },
    { raw: '9876543211', phone: '919876543211', name: 'User 2', jid: '919876543211@s.whatsapp.net' },
    { raw: '9876543212', phone: '919876543212', name: 'User 3', jid: '919876543212@s.whatsapp.net' },
  ];

  await queue.start(contacts, 'Test message', 'over_safe');
  assert.equal(queue.getState().status, 'running');

  // Trigger abort immediately
  const abortResult = queue.abort();
  assert.equal(abortResult.success, true);
  assert.equal(queue.getState().status, 'aborted');
  assert.equal(queue.getState().statusMessage, 'Broadcast aborted by operator.');

  // Calling abort again returns appropriate response without crashing
  const secondAbort = queue.abort();
  assert.equal(secondAbort.success, false);
});

test('DispatchQueue abort unblocks paused queue immediately', async () => {
  const mockSocket = new MockWASocket();
  const queue = new DispatchQueue(() => mockSocket);

  const contacts: ContactItem[] = [
    { raw: '9876543210', phone: '919876543210', name: 'User 1', jid: '919876543210@s.whatsapp.net' },
    { raw: '9876543211', phone: '919876543211', name: 'User 2', jid: '919876543211@s.whatsapp.net' },
  ];

  await queue.start(contacts, 'Test message', 'balanced');
  queue.pause();
  assert.equal(queue.getState().status, 'paused');

  // Aborting while paused must immediately wake up and transition to aborted
  const abortResult = queue.abort();
  assert.equal(abortResult.success, true);
  assert.equal(queue.getState().status, 'aborted');
});
