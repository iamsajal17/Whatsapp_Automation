/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * GDG on Campus - IET DAVV Indore
 * WhatsApp Broadcast Engine (Standalone Node.js Runtime)
 */

import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// 1. SANITIZATION & CONTACT PARSER
// ==========================================
export function sanitizePhoneNumber(input) {
  if (!input || typeof input !== 'string') return null;
  let cleaned = input.trim().replace(/^(tel:|whatsapp:)/i, '');
  cleaned = cleaned.replace(/\D/g, '');
  if (!cleaned) return null;

  if (cleaned.length === 11 && cleaned.startsWith('0') && /^[6-9]/.test(cleaned.slice(1))) {
    cleaned = '91' + cleaned.slice(1);
  }

  if (cleaned.length === 10 && /^[6-9]/.test(cleaned)) {
    cleaned = '91' + cleaned;
  }

  if (cleaned.length < 10 || cleaned.length > 15) {
    return null;
  }

  return cleaned;
}

export function maskPhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return '••••••';
  const clean = phone.replace(/\D/g, '');
  if (clean.length < 7) return '••••••';
  if (clean.startsWith('91') && clean.length === 12) {
    const mobilePrefix = clean.slice(2, 6);
    return `+91 ${mobilePrefix} •••••`;
  }
  const prefix = clean.slice(0, Math.min(5, clean.length - 4));
  const suffix = clean.slice(-2);
  const maskedLength = Math.max(3, clean.length - prefix.length - suffix.length);
  return `+${prefix} ${'•'.repeat(maskedLength)} ${suffix}`;
}

export function maskName(name) {
  if (!name || typeof name !== 'string' || name.trim() === 'Member') return 'Member';
  const parts = name.trim().split(/\s+/);
  return parts
    .map(p => (p.length <= 1 ? p : p[0] + '•'.repeat(Math.min(4, p.length - 1))))
    .join(' ');
}

export function parseContacts(rawText, maxContacts = 800) {
  if (!rawText || !rawText.trim()) {
    return { contacts: [], duplicatesCount: 0, invalidCount: 0, invalidLines: [] };
  }

  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const seenPhones = new Set();
  const contacts = [];
  const invalidLines = [];
  let duplicatesCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && /(phone|mobile|number|contact)/i.test(line) && /(name|fullname|user)/i.test(line)) {
      continue;
    }

    let phoneCandidate = '';
    let nameCandidate = '';
    const parts = line.split(/[,\t]/).map(p => p.trim());

    if (parts.length >= 2) {
      const d0 = parts[0].replace(/\D/g, '');
      const d1 = parts[1].replace(/\D/g, '');
      if (d0.length >= 10 && d1.length < 10) {
        phoneCandidate = parts[0];
        nameCandidate = parts[1];
      } else if (d1.length >= 10 && d0.length < 10) {
        nameCandidate = parts[0];
        phoneCandidate = parts[1];
      } else {
        phoneCandidate = parts[0];
        nameCandidate = parts[1];
      }
    } else {
      phoneCandidate = line;
      nameCandidate = '';
    }

    const sanitized = sanitizePhoneNumber(phoneCandidate);
    if (!sanitized) {
      invalidLines.push(line);
      continue;
    }

    if (seenPhones.has(sanitized)) {
      duplicatesCount++;
      continue;
    }

    if (contacts.length >= maxContacts) {
      break;
    }

    seenPhones.add(sanitized);
    contacts.push({
      raw: line,
      phone: sanitized,
      name: nameCandidate || 'Member',
      jid: `${sanitized}@s.whatsapp.net`,
    });
  }

  return { contacts, duplicatesCount, invalidCount: invalidLines.length, invalidLines };
}

// ==========================================
// 2. PACING & GAUSSIAN JITTER
// ==========================================
export const PACING_PRESETS = {
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
};

function randomGaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function getGaussianJitter(baseMs, minMs, maxMs) {
  const stdDev = (maxMs - minMs) / 6;
  const val = baseMs + randomGaussian() * stdDev;
  return Math.round(Math.min(maxMs, Math.max(minMs, val)));
}

export function getTypingDuration(minMs = 1200, maxMs = 2500) {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

export function getNextBatchThreshold(minMsgs = 40, maxMsgs = 55) {
  return Math.floor(minMsgs + Math.random() * (maxMsgs - minMsgs + 1));
}

export function getCooldownDuration(minMs = 45000, maxMs = 75000) {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

export function calculateRemainingSeconds(remainingItems, config, currentBatchCount) {
  if (remainingItems <= 0) return 0;
  const avgIntervalSec = (config.jitterMinMs + config.jitterMaxMs) / 2000;
  const avgCooldownSec = (config.cooldownDurationMinMs + config.cooldownDurationMaxMs) / 2000;
  const avgBatchThreshold = (config.cooldownBatchMin + config.cooldownBatchMax) / 2;
  const intervalsDuration = remainingItems * avgIntervalSec;
  const itemsUntilNext = Math.max(0, avgBatchThreshold - currentBatchCount);
  const remainingAfterNext = Math.max(0, remainingItems - itemsUntilNext);
  const totalCooldowns = (itemsUntilNext > 0 ? 1 : 0) + Math.floor(remainingAfterNext / avgBatchThreshold);
  return Math.round(intervalsDuration + totalCooldowns * avgCooldownSec);
}

export function formatDuration(seconds) {
  if (isNaN(seconds) || seconds <= 0) return '0s';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts = [];
  if (hrs > 0) parts.push(`${hrs}h`);
  if (mins > 0 || hrs > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

// ==========================================
// 3. ZERO-WIDTH ENTROPY & PERSONALIZATION
// ==========================================
const ZERO_WIDTH_CHARS = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
const GREETINGS = ['Hello', 'Hi', 'Greetings', 'Hey'];

export function generateZeroWidthEntropyToken(seed) {
  const hash = createHash('sha256').update(String(seed) + Date.now().toString()).digest('hex');
  let result = '';
  for (let i = 0; i < 8; i++) {
    const val = parseInt(hash[i], 16) % ZERO_WIDTH_CHARS.length;
    result += ZERO_WIDTH_CHARS[val];
  }
  return result;
}

export function getMessageDigest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

export function personalizeMessage(template, contact, index) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

  const rawName = (contact.name && contact.name.trim()) || 'Member';
  const firstName = rawName.split(' ')[0] || rawName;
  const greeting = GREETINGS[index % GREETINGS.length];
  const ref = `GDG-${(1000 + (index % 9000)).toString(16).toUpperCase()}`;

  const processed = template
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
  const entropyToken = generateZeroWidthEntropyToken(`${contact.phone}_${index}_${Date.now()}`);
  const finalPayload = processed + entropyToken;
  const digest = getMessageDigest(finalPayload);

  return { visibleText, finalPayload, digest };
}

// ==========================================
// 4. SMART PACING DISPATCH QUEUE
// ==========================================
export class DispatchQueue {
  constructor(socketProvider) {
    this.socketProvider = socketProvider;
    this.status = 'idle';
    this.pacingMode = 'balanced';
    this.contacts = [];
    this.messageTemplate = '';
    this.total = 0;
    this.sent = 0;
    this.skipped = 0;
    this.failed = 0;
    this.currentIndex = 0;
    this.currentContact = null;
    this.statusMessage = 'Queue is idle. Ready to dispatch.';
    this.batchCurrent = 0;
    this.batchTarget = 45;
    this.cooldownEndsAt = null;
    this.startedAt = null;
    this.completedAt = null;
    this.logs = [];
    this.abortRequested = false;
    this.pauseRequested = false;
    this.resumeResolve = null;
    this.onStateChangeCallback = null;
  }

  setOnStateChange(cb) {
    this.onStateChangeCallback = cb;
  }

  notify() {
    if (this.onStateChangeCallback) {
      this.onStateChangeCallback(this.getState());
    }
  }

  clearLogs() {
    this.logs = [];
    this.notify();
  }

  addLog(level, message, contact, digest) {
    const maskedContact = contact
      ? {
          name: maskName(contact.name),
          phone: maskPhoneNumber(contact.phone),
        }
      : undefined;

    const maskedMessage = message.replace(/(\+?\d{10,15})/g, (m) => maskPhoneNumber(m));

    const entry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }),
      level,
      message: maskedMessage,
      contact: maskedContact,
      digest,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 150) this.logs.pop();
    this.notify();
  }

  async sleep(ms) {
    const step = 200;
    let elapsed = 0;
    while (elapsed < ms) {
      if (this.abortRequested) break;
      await new Promise(r => setTimeout(r, Math.min(step, ms - elapsed)));
      elapsed += step;
      if (this.pauseRequested && !this.abortRequested) {
        await new Promise(resolve => {
          this.resumeResolve = resolve;
        });
      }
    }
  }

  getState() {
    const config = PACING_PRESETS[this.pacingMode] || PACING_PRESETS.balanced;
    const remaining = Math.max(0, this.total - (this.sent + this.skipped + this.failed));
    const etaSeconds = calculateRemainingSeconds(remaining, config, this.batchCurrent);

    let cooldownRemainingSeconds = 0;
    if (this.status === 'cooldown' && this.cooldownEndsAt) {
      cooldownRemainingSeconds = Math.max(0, Math.ceil((this.cooldownEndsAt - Date.now()) / 1000));
    }

    return {
      status: this.status,
      pacingMode: this.pacingMode,
      total: this.total,
      sent: this.sent,
      skipped: this.skipped,
      failed: this.failed,
      currentIndex: this.currentIndex,
      currentContact: this.currentContact,
      statusMessage: this.statusMessage,
      etaSeconds,
      etaFormatted: formatDuration(etaSeconds),
      batchCurrent: this.batchCurrent,
      batchTarget: this.batchTarget,
      cooldownEndsAt: this.cooldownEndsAt,
      cooldownRemainingSeconds,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      logs: this.logs,
    };
  }

  async start(contacts, messageTemplate, pacingMode = 'balanced') {
    if (this.status === 'running' || this.status === 'cooldown') {
      return { success: false, error: 'Broadcast queue is already running' };
    }
    if (!contacts || contacts.length === 0) {
      return { success: false, error: 'Cannot start dispatch: No contacts provided' };
    }
    if (!messageTemplate || !messageTemplate.trim()) {
      return { success: false, error: 'Cannot start dispatch: Message body is empty' };
    }
    const socket = this.socketProvider();
    if (!socket) {
      return { success: false, error: 'WhatsApp is not connected. Please scan QR first.' };
    }

    const resolvedMode =
      pacingMode === 'stealth_4h' ? 'ultra_safe' :
      pacingMode === 'guardian' ? 'guardian_8h' :
      (PACING_PRESETS[pacingMode] ? pacingMode : 'balanced');

    this.status = 'running';
    this.pacingMode = resolvedMode;
    this.contacts = contacts;
    this.messageTemplate = messageTemplate;
    this.total = contacts.length;
    this.sent = 0;
    this.skipped = 0;
    this.failed = 0;
    this.currentIndex = 0;
    this.batchCurrent = 0;
    this.batchTarget = getNextBatchThreshold(
      PACING_PRESETS[resolvedMode].cooldownBatchMin,
      PACING_PRESETS[resolvedMode].cooldownBatchMax
    );
    this.startedAt = new Date().toISOString();
    this.completedAt = null;
    this.abortRequested = false;
    this.pauseRequested = false;
    this.cooldownEndsAt = null;

    this.addLog('info', `Broadcast started for ${this.total} contacts via ${resolvedMode.toUpperCase()} mode.`);
    this.runLoop().catch(err => {
      this.status = 'aborted';
      this.statusMessage = `Error: ${err?.message || 'Broadcast error'}`;
      this.addLog('error', `Error: ${err?.message || err}`);
      this.notify();
    });

    return { success: true };
  }

  pause() {
    if (this.status !== 'running' && this.status !== 'cooldown') {
      return { success: false, message: 'Queue is not active' };
    }
    this.pauseRequested = true;
    this.status = 'paused';
    this.statusMessage = 'Queue paused by operator.';
    this.addLog('warn', 'Broadcast paused by operator.');
    this.notify();
    return { success: true, message: 'Queue paused' };
  }

  resume() {
    if (this.status !== 'paused') {
      return { success: false, message: 'Queue is not paused' };
    }
    this.pauseRequested = false;
    this.status = 'running';
    this.statusMessage = 'Resuming broadcast queue...';
    this.addLog('info', 'Broadcast resumed by operator.');
    if (this.resumeResolve) {
      const resolve = this.resumeResolve;
      this.resumeResolve = null;
      resolve();
    }
    this.notify();
    return { success: true, message: 'Queue resumed' };
  }

  abort() {
    if (this.status === 'idle' || this.status === 'completed' || this.status === 'aborted') {
      return { success: false, message: 'No active queue to abort' };
    }
    this.abortRequested = true;
    this.pauseRequested = false;
    this.status = 'aborted';
    this.statusMessage = 'Broadcast stopped by operator.';
    this.completedAt = new Date().toISOString();
    this.addLog('warn', `Emergency abort executed at ${this.currentIndex + 1} of ${this.total}.`);
    if (this.resumeResolve) {
      const resolve = this.resumeResolve;
      this.resumeResolve = null;
      resolve();
    }
    this.notify();
    return { success: true, message: 'Queue aborted' };
  }

  reset(clearLogs = true) {
    if (this.status === 'running' || this.status === 'cooldown') {
      this.abort();
    }
    this.status = 'idle';
    this.total = 0;
    this.sent = 0;
    this.skipped = 0;
    this.failed = 0;
    this.currentIndex = 0;
    this.currentContact = null;
    this.contacts = [];
    this.messageTemplate = '';
    this.statusMessage = 'Queue is idle. Ready to dispatch.';
    this.startedAt = null;
    this.completedAt = null;
    this.cooldownEndsAt = null;
    if (clearLogs) {
      this.logs = [];
    }
    this.notify();
  }

  async runLoop() {
    const config = PACING_PRESETS[this.pacingMode] || PACING_PRESETS.balanced;

    for (let i = 0; i < this.contacts.length; i++) {
      if (this.abortRequested) break;

      if (this.pauseRequested) {
        await new Promise(resolve => {
          this.resumeResolve = resolve;
        });
        if (this.abortRequested) break;
      }

      this.currentIndex = i;
      const contact = this.contacts[i];
      this.currentContact = {
        ...contact,
        phone: maskPhoneNumber(contact.phone),
        name: maskName(contact.name),
      };

      let socket = this.socketProvider();
      if (!socket) {
        this.addLog('warn', 'WhatsApp socket disconnected. Waiting for connection...');
        this.status = 'paused';
        this.statusMessage = 'WhatsApp disconnected. Waiting for connection...';
        this.pauseRequested = true;
        this.notify();
        await new Promise(resolve => {
          this.resumeResolve = resolve;
        });
        if (this.abortRequested) break;
      }

      socket = this.socketProvider();
      const maskedPhone = maskPhoneNumber(contact.phone);
      const maskedNameStr = maskName(contact.name);

      try {
        this.status = 'running';
        this.statusMessage = `Verifying WhatsApp presence for ${maskedPhone}...`;
        this.notify();

        let registered = true;
        try {
          const results = await socket.onWhatsApp(contact.jid);
          if (Array.isArray(results) && results.length > 0) {
            registered = results[0].exists;
          }
        } catch (_) {
          registered = true;
        }

        if (!registered) {
          this.skipped++;
          this.statusMessage = `Skipped ${maskedPhone} (Not on WhatsApp)`;
          this.addLog('warn', `Skipped ${maskedPhone} (${maskedNameStr}): Not on WhatsApp`, contact);
          this.notify();
          await this.sleep(1000);
          continue;
        }

        // Typing simulation
        const typingDuration = getTypingDuration(config.typingMinMs, config.typingMaxMs);
        this.statusMessage = `Simulating typing to ${maskedNameStr} (${maskedPhone})...`;
        this.notify();

        try {
          await socket.sendPresenceUpdate('composing', contact.jid);
        } catch (_) {}

        await this.sleep(typingDuration);
        if (this.abortRequested) break;

        const { finalPayload, digest } = personalizeMessage(this.messageTemplate, contact, i);

        try {
          await socket.sendPresenceUpdate('paused', contact.jid);
        } catch (_) {}

        this.statusMessage = `Dispatching payload to ${maskedPhone} [Hash #${digest}]...`;
        this.notify();

        await socket.sendMessage(contact.jid, { text: finalPayload });

        this.sent++;
        this.batchCurrent++;
        this.statusMessage = `Sent to ${maskedNameStr} (${maskedPhone}) [Hash #${digest}]`;
        this.addLog('success', `Dispatched to ${maskedNameStr} (${maskedPhone})`, contact, `#${digest}`);
        this.notify();

        if (i === this.contacts.length - 1) break;

        // Batch Cooldown Breather
        if (this.batchCurrent >= this.batchTarget) {
          const cooldownMs = getCooldownDuration(config.cooldownDurationMinMs, config.cooldownDurationMaxMs);
          const cooldownSec = Math.round(cooldownMs / 1000);
          this.status = 'cooldown';
          this.cooldownEndsAt = Date.now() + cooldownMs;
          this.addLog('cooldown', `Batch breather: ${this.batchCurrent} msgs sent. Cooling down for ${cooldownSec}s...`);
          this.notify();

          const cooldownStart = Date.now();
          while (Date.now() - cooldownStart < cooldownMs) {
            if (this.abortRequested) break;
            const remaining = Math.max(0, Math.ceil((cooldownMs - (Date.now() - cooldownStart)) / 1000));
            this.statusMessage = `Micro-batch breather: resting for account safety (${remaining}s remaining)...`;
            this.notify();
            await this.sleep(1000);
          }

          if (this.abortRequested) break;

          this.batchCurrent = 0;
          this.batchTarget = getNextBatchThreshold(config.cooldownBatchMin, config.cooldownBatchMax);
          this.cooldownEndsAt = null;
          this.status = 'running';
          this.addLog('info', `Breather complete. Next micro-batch target: ${this.batchTarget} messages.`);
          this.notify();
        } else {
          // Gaussian Jitter
          const jitterDelayMs = getGaussianJitter(config.baseIntervalMs, config.jitterMinMs, config.jitterMaxMs);
          this.statusMessage = `Pacing next message in ${(jitterDelayMs / 1000).toFixed(1)}s (Stochastic Jitter)...`;
          this.notify();
          await this.sleep(jitterDelayMs);
        }
      } catch (err) {
        this.failed++;
        this.statusMessage = `Failed sending to +${contact.phone}: ${err?.message || 'Error'}`;
        this.addLog('error', `Failed sending to +${contact.phone} (${contact.name}): ${err?.message || err}`, contact);
        this.notify();
        await this.sleep(2000);
      }
    }

    if (this.abortRequested) {
      this.status = 'aborted';
      this.statusMessage = 'Broadcast was stopped.';
    } else {
      this.status = 'completed';
      this.statusMessage = `Broadcast completed! Sent ${this.sent} / ${this.total} successfully.`;
      this.completedAt = new Date().toISOString();
      this.addLog('info', `Broadcast finished! Sent: ${this.sent}, Skipped: ${this.skipped}, Failed: ${this.failed}.`);
    }
    this.currentContact = null;
    this.notify();
  }
}

// ==========================================
// 5. BAILEYS WHATSAPP CLIENT MANAGER
// ==========================================
export class WhatsAppManager {
  constructor(sessionDir = './wa_auth_session') {
    this.sessionDir = path.resolve(process.cwd(), sessionDir);
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
    this.sock = null;
    this.connectionState = 'disconnected';
    this.qrCodeDataUrl = null;
    this.accountInfo = null;
    this.io = null;
    this.isInitializing = false;
    this.reconnectTimer = null;
  }

  setSocketIO(io) {
    this.io = io;
  }

  getSocket() {
    return this.connectionState === 'connected' ? this.sock : null;
  }

  getState() {
    return {
      connectionState: this.connectionState,
      qrCodeDataUrl: this.qrCodeDataUrl,
      accountInfo: this.accountInfo,
      isInitializing: this.isInitializing,
    };
  }

  broadcastState() {
    if (this.io) {
      this.io.emit('wa_status', this.getState());
    }
  }

  async initialize() {
    if (this.isInitializing) return;
    if (this.connectionState === 'connected' && this.sock) return;

    this.isInitializing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      this.connectionState = 'connecting';
      this.broadcastState();

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      let version = [2, 3000, 1015901307];

      try {
        const fetched = await fetchLatestBaileysVersion();
        if (fetched?.version) version = fetched.version;
      } catch (_) {}

      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners('connection.update');
          this.sock.ev.removeAllListeners('creds.update');
          this.sock.end(undefined);
        } catch (_) {}
        this.sock = null;
      }

      this.sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.qrCodeDataUrl = await QRCode.toDataURL(qr, {
              margin: 2,
              scale: 8,
              color: { dark: '#0f172a', light: '#ffffff' },
            });
            this.connectionState = 'qr_ready';
            this.broadcastState();
          } catch (qrErr) {
            console.error('QR rendering error:', qrErr);
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;

          this.qrCodeDataUrl = null;
          this.accountInfo = null;
          this.connectionState = 'disconnected';
          this.broadcastState();

          if (isLoggedOut) {
            if (fs.existsSync(this.sessionDir)) {
              fs.rmSync(this.sessionDir, { recursive: true, force: true });
              fs.mkdirSync(this.sessionDir, { recursive: true });
            }
          }

          this.isInitializing = false;
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            this.initialize();
          }, 2500);
        } else if (connection === 'open') {
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.connectionState = 'connected';
          this.qrCodeDataUrl = null;

          const rawUser = this.sock?.user;
          const jid = rawUser?.id || '';
          const phone = jid.split(':')[0] || jid.split('@')[0] || '';
          const name = rawUser?.name || 'Authorized Broadcast Account';

          this.accountInfo = {
            id: jid,
            name,
            phone,
            connectedAt: new Date().toISOString(),
          };

          this.broadcastState();
        }
      });
    } catch (err) {
      console.error('WhatsApp initialization error:', err);
      this.connectionState = 'disconnected';
      this.broadcastState();
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.isInitializing = false;
        this.initialize();
      }, 4000);
    } finally {
      this.isInitializing = false;
    }
  }

  async refreshQR() {
    if (this.sock) {
      try { this.sock.end(undefined); } catch (_) {}
      this.sock = null;
    }
    this.connectionState = 'disconnected';
    this.qrCodeDataUrl = null;
    this.broadcastState();
    this.isInitializing = false;
    await this.initialize();
    return { success: true, qrCodeDataUrl: this.qrCodeDataUrl };
  }

  async unlink() {
    try {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.sock) {
        try { await this.sock.logout(); } catch (_) {}
        try { this.sock.end(new Error('Unlinked')); } catch (_) {}
        this.sock = null;
      }

      if (fs.existsSync(this.sessionDir)) {
        fs.rmSync(this.sessionDir, { recursive: true, force: true });
        fs.mkdirSync(this.sessionDir, { recursive: true });
      }

      this.connectionState = 'disconnected';
      this.accountInfo = null;
      this.qrCodeDataUrl = null;
      this.broadcastState();

      setTimeout(() => {
        this.isInitializing = false;
        this.initialize();
      }, 1000);

      return { success: true, message: 'Unlinked. Fresh QR generated.' };
    } catch (err) {
      return { success: false, message: `Failed to unlink: ${err?.message || err}` };
    }
  }
}

// ==========================================
// 6. EXPRESS & SOCKET.IO APP SERVER
// ==========================================
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

const publicDir = path.resolve(__dirname, 'public');
app.use(express.static(publicDir));

const waManager = new WhatsAppManager('./wa_auth_session');
waManager.setSocketIO(io);

const dispatchQueue = new DispatchQueue(() => waManager.getSocket());
dispatchQueue.setOnStateChange((state) => {
  io.emit('queue_state', state);
});

io.on('connection', (socket) => {
  socket.emit('wa_status', waManager.getState());
  socket.emit('queue_state', dispatchQueue.getState());

  socket.on('request_state', () => {
    socket.emit('wa_status', waManager.getState());
    socket.emit('queue_state', dispatchQueue.getState());
  });

  socket.on('start_dispatch', async (data) => {
    const { contactsRaw, message, pacingMode = 'balanced' } = data;
    const { contacts } = parseContacts(contactsRaw, 800);
    const result = await dispatchQueue.start(contacts, message, pacingMode);
    socket.emit('dispatch_action_result', result);
  });

  socket.on('pause_dispatch', () => {
    socket.emit('dispatch_action_result', dispatchQueue.pause());
  });

  socket.on('resume_dispatch', () => {
    socket.emit('dispatch_action_result', dispatchQueue.resume());
  });

  socket.on('abort_dispatch', () => {
    socket.emit('dispatch_action_result', dispatchQueue.abort());
  });

  socket.on('reset_dispatch', () => {
    dispatchQueue.reset(true);
  });

  socket.on('clear_logs', () => {
    dispatchQueue.clearLogs();
  });

  socket.on('unlink_wa', async () => {
    dispatchQueue.reset(true);
    socket.emit('unlink_result', await waManager.unlink());
  });
});

app.get('/api/status', (_req, res) => {
  res.json({
    whatsapp: waManager.getState(),
    queue: dispatchQueue.getState(),
    serverTime: new Date().toISOString(),
  });
});

app.post('/api/contacts/validate', (req, res) => {
  const { text, max = 800 } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Text content is required' });
  }
  const result = parseContacts(text, Number(max) || 800);
  res.json({
    validCount: result.contacts.length,
    contacts: result.contacts,
    duplicatesCount: result.duplicatesCount,
    invalidCount: result.invalidCount,
    invalidLines: result.invalidLines,
  });
});

app.post('/api/dispatch/start', async (req, res) => {
  const { contacts, contactsRaw, message, pacingMode = 'balanced' } = req.body;
  let parsedContacts = contacts;
  if (!Array.isArray(parsedContacts) && typeof contactsRaw === 'string') {
    parsedContacts = parseContacts(contactsRaw, 800).contacts;
  }
  const result = await dispatchQueue.start(parsedContacts, message, pacingMode);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

app.post('/api/dispatch/pause', (_req, res) => res.json(dispatchQueue.pause()));
app.post('/api/dispatch/resume', (_req, res) => res.json(dispatchQueue.resume()));
app.post('/api/dispatch/abort', (_req, res) => res.json(dispatchQueue.abort()));
app.post('/api/dispatch/reset', (_req, res) => {
  dispatchQueue.reset(true);
  res.json({ success: true, message: 'Queue and logs wiped from memory' });
});

app.post('/api/logs/clear', (_req, res) => {
  dispatchQueue.clearLogs();
  res.json({ success: true, message: 'Logs purged from memory' });
});

app.post('/api/auth/unlink', async (_req, res) => {
  dispatchQueue.reset(true);
  res.json(await waManager.unlink());
});

// QR Code Direct HTTP Fallback Endpoints
app.get('/api/qr', (_req, res) => {
  const state = waManager.getState();
  if (state.connectionState === 'disconnected') {
    waManager.initialize().catch(console.error);
  }
  res.json(state);
});

app.post('/api/qr/refresh', async (_req, res) => {
  const result = await waManager.refreshQR();
  res.json({ ...result, ...waManager.getState() });
});

app.get('*', (_req, res) => {
  res.sendFile(path.resolve(publicDir, 'index.html'));
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`[GDG WhatsApp Broadcast] Server running on port ${PORT}`);
  console.log(`[GDG WhatsApp Broadcast] Dashboard at http://localhost:${PORT}`);
  waManager.initialize().catch(err => {
    console.error('Initial WhatsApp boot error:', err);
  });
});
