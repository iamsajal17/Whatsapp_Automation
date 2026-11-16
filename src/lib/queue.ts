/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ContactItem, maskPhoneNumber, maskName } from './sanitizer.ts';
import {
  PacingConfig,
  PacingMode,
  PACING_PRESETS,
  getGaussianJitter,
  getTypingDuration,
  getNextBatchThreshold,
  getCooldownDuration,
  calculateRemainingSeconds,
  formatDuration,
} from './pacing.ts';
import { personalizeMessage } from './entropy.ts';

export type QueueStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'cooldown'
  | 'completed'
  | 'aborted';

export interface QueueLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warn' | 'error' | 'cooldown';
  message: string;
  contact?: {
    name: string;
    phone: string;
  };
  digest?: string;
}

export interface QueueState {
  status: QueueStatus;
  pacingMode: PacingMode;
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  currentIndex: number;
  currentContact: ContactItem | null;
  statusMessage: string;
  etaSeconds: number;
  etaFormatted: string;
  batchCurrent: number;
  batchTarget: number;
  cooldownEndsAt: number | null;
  cooldownRemainingSeconds: number;
  startedAt: string | null;
  completedAt: string | null;
  logs: QueueLogEntry[];
}

export interface WASocketLike {
  onWhatsApp: (jid: string) => Promise<Array<{ exists: boolean; jid: string }> | undefined>;
  sendPresenceUpdate: (type: 'composing' | 'paused' | 'available' | 'unavailable', toJid?: string) => Promise<void>;
  sendMessage: (jid: string, content: { text: string }) => Promise<any>;
}

export class DispatchQueue {
  private status: QueueStatus = 'idle';
  private pacingMode: PacingMode = 'balanced';
  private contacts: ContactItem[] = [];
  private messageTemplate = '';
  private socketProvider: () => WASocketLike | null;

  private total = 0;
  private sent = 0;
  private skipped = 0;
  private failed = 0;
  private currentIndex = 0;
  private currentContact: ContactItem | null = null;
  private statusMessage = 'Queue is idle. Ready to dispatch.';

  private batchCurrent = 0;
  private batchTarget = 45;
  private cooldownEndsAt: number | null = null;
  private startedAt: string | null = null;
  private completedAt: string | null = null;

  private logs: QueueLogEntry[] = [];
  private abortRequested = false;
  private pauseRequested = false;
  private resumeResolve: (() => void) | null = null;
  private activeSleepResolve: (() => void) | null = null;

  private onStateChangeCallback?: (state: QueueState) => void;

  constructor(socketProvider: () => WASocketLike | null) {
    this.socketProvider = socketProvider;
  }

  public setOnStateChange(cb: (state: QueueState) => void) {
    this.onStateChangeCallback = cb;
  }

  private notify() {
    if (this.onStateChangeCallback) {
      this.onStateChangeCallback(this.getState());
    }
  }

  private addLog(
    level: QueueLogEntry['level'],
    message: string,
    contact?: { name: string; phone: string },
    digest?: string
  ) {
    // Mask contact for privacy
    const maskedContact = contact
      ? {
          name: maskName(contact.name),
          phone: maskPhoneNumber(contact.phone),
        }
      : undefined;

    // Mask any raw numbers present in log message text
    const maskedMessage = message.replace(/(\+?\d{10,15})/g, (m) => maskPhoneNumber(m));

    const entry: QueueLogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }),
      level,
      message: maskedMessage,
      contact: maskedContact,
      digest,
    };

    this.logs.unshift(entry);
    // Keep last 150 log entries to prevent memory leak
    if (this.logs.length > 150) {
      this.logs.pop();
    }
    this.notify();
  }

  private async sleep(ms: number): Promise<void> {
    if (this.abortRequested) return;

    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null;

      const finish = () => {
        if (timer) clearTimeout(timer);
        this.activeSleepResolve = null;
        resolve();
      };

      this.activeSleepResolve = finish;
      timer = setTimeout(finish, ms);
    });

    // Handle pause during sleep
    if (this.pauseRequested && !this.abortRequested) {
      await new Promise<void>((resolve) => {
        this.resumeResolve = resolve;
      });
    }
  }

  public getState(): QueueState {
    const config = PACING_PRESETS[this.pacingMode];
    const remaining = Math.max(0, this.total - (this.sent + this.skipped + this.failed));
    const etaSeconds = calculateRemainingSeconds(remaining, config, this.batchCurrent);

    let cooldownRemainingSeconds = 0;
    if (this.status === 'cooldown' && this.cooldownEndsAt) {
      cooldownRemainingSeconds = Math.max(0, Math.ceil((this.cooldownEndsAt - Date.now()) / 1000));
    }

    const effectiveStatus = this.abortRequested ? 'aborted' : this.status;

    return {
      status: effectiveStatus,
      pacingMode: this.pacingMode,
      total: this.total,
      sent: this.sent,
      skipped: this.skipped,
      failed: this.failed,
      currentIndex: this.currentIndex,
      currentContact: this.currentContact,
      statusMessage: this.statusMessage,
      etaSeconds: effectiveStatus === 'aborted' ? 0 : etaSeconds,
      etaFormatted: effectiveStatus === 'aborted' ? '0s' : formatDuration(etaSeconds),
      batchCurrent: this.batchCurrent,
      batchTarget: this.batchTarget,
      cooldownEndsAt: effectiveStatus === 'aborted' ? null : this.cooldownEndsAt,
      cooldownRemainingSeconds: effectiveStatus === 'aborted' ? 0 : cooldownRemainingSeconds,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      logs: this.logs,
    };
  }

  public async start(
    contacts: ContactItem[],
    messageTemplate: string,
    pacingMode: PacingMode = 'balanced'
  ): Promise<{ success: boolean; error?: string }> {
    if (this.status === 'running' || this.status === 'cooldown') {
      return { success: false, error: 'A broadcast queue is already currently running' };
    }

    if (!contacts || contacts.length === 0) {
      return { success: false, error: 'Cannot start dispatch: No contacts provided' };
    }

    if (!messageTemplate || !messageTemplate.trim()) {
      return { success: false, error: 'Cannot start dispatch: Message template is empty' };
    }

    const socket = this.socketProvider();
    if (!socket) {
      return { success: false, error: 'WhatsApp is not connected. Please scan the QR code first.' };
    }

    const resolvedMode: PacingMode =
      (pacingMode as string) === 'stealth_4h' ? 'ultra_safe' :
      (pacingMode as string) === 'guardian' ? 'guardian_8h' :
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

    this.addLog(
      'info',
      `Broadcast started for ${this.total} contacts using ${pacingMode.toUpperCase()} pacing mode.`
    );

    // Launch background dispatch loop autonomously
    this.runLoop().catch(err => {
      this.status = 'aborted';
      this.statusMessage = `Queue execution error: ${err?.message || 'Unknown error'}`;
      this.addLog('error', `Fatal error during broadcast: ${err?.message || err}`);
      this.notify();
    });

    return { success: true };
  }

  public pause(): { success: boolean; message: string } {
    if (this.status !== 'running' && this.status !== 'cooldown') {
      return { success: false, message: 'Queue is not active' };
    }

    this.pauseRequested = true;
    this.status = 'paused';
    this.statusMessage = 'Queue paused by operator. Ready to resume.';
    this.addLog('warn', 'Broadcast paused by operator.');
    this.notify();
    return { success: true, message: 'Queue paused' };
  }

  public resume(): { success: boolean; message: string } {
    if (this.status !== 'paused') {
      return { success: false, message: 'Queue is not in paused state' };
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

  public abort(): { success: boolean; message: string } {
    if (this.status === 'idle' || this.status === 'completed' || (this.status === 'aborted' && this.abortRequested)) {
      return { success: false, message: 'No active queue to abort' };
    }

    this.abortRequested = true;
    this.pauseRequested = false;
    this.status = 'aborted';
    this.statusMessage = 'Broadcast aborted by operator.';
    this.cooldownEndsAt = null;
    this.completedAt = new Date().toISOString();
    this.addLog('warn', `Emergency abort executed at message ${this.currentIndex + 1} of ${this.total}.`);

    // Instantly wake up any active sleep timer (0ms)
    if (this.activeSleepResolve) {
      const resolveSleep = this.activeSleepResolve;
      this.activeSleepResolve = null;
      resolveSleep();
    }

    // Instantly unblock any paused promise
    if (this.resumeResolve) {
      const resolveResume = this.resumeResolve;
      this.resumeResolve = null;
      resolveResume();
    }

    // Reset presence on active socket to avoid lingering composing presence
    try {
      const socket = this.socketProvider();
      if (socket && this.currentContact?.jid) {
        socket.sendPresenceUpdate('paused', this.currentContact.jid).catch(() => {});
      }
    } catch (_) {}

    this.notify();
    return { success: true, message: 'Queue aborted successfully' };
  }

  public clearLogs(): void {
    this.logs = [];
    this.notify();
  }

  public reset(clearLogs = true): void {
    if (this.status === 'running' || this.status === 'cooldown' || this.status === 'paused') {
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
    this.abortRequested = false;
    this.pauseRequested = false;

    if (this.activeSleepResolve) {
      const resolveSleep = this.activeSleepResolve;
      this.activeSleepResolve = null;
      resolveSleep();
    }
    if (this.resumeResolve) {
      const resolveResume = this.resumeResolve;
      this.resumeResolve = null;
      resolveResume();
    }

    if (clearLogs) {
      this.logs = [];
    }
    this.notify();
  }

  private async runLoop() {
    const config = PACING_PRESETS[this.pacingMode];

    for (let i = 0; i < this.contacts.length; i++) {
      if (this.abortRequested) break;

      // Handle pause request
      if (this.pauseRequested) {
        await new Promise<void>(resolve => {
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

      const socket = this.socketProvider();
      if (!socket) {
        this.addLog('warn', 'WhatsApp socket disconnected. Pausing queue until reconnection.');
        this.status = 'paused';
        this.statusMessage = 'WhatsApp disconnected. Waiting for connection...';
        this.pauseRequested = true;
        this.notify();
        await new Promise<void>(resolve => {
          this.resumeResolve = resolve;
        });
        if (this.abortRequested) break;
      }

      const activeSocket = this.socketProvider()!;
      const maskedPhone = maskPhoneNumber(contact.phone);
      const maskedNameStr = maskName(contact.name);

      try {
        if (this.abortRequested) break;

        // Step 1: Presence Verification (onWhatsApp check)
        this.status = 'running';
        this.statusMessage = `Verifying WhatsApp registration for ${maskedPhone}...`;
        this.notify();

        let registered = true;
        try {
          const results = await activeSocket.onWhatsApp(contact.jid);
          if (Array.isArray(results) && results.length > 0) {
            registered = results[0].exists;
          }
        } catch (checkErr) {
          registered = true;
        }

        if (this.abortRequested) break;

        if (!registered) {
          this.skipped++;
          this.statusMessage = `Skipped ${maskedPhone} (Not registered on WhatsApp)`;
          this.addLog(
            'warn',
            `Skipped ${maskedPhone} (${maskedNameStr}): Number not found on WhatsApp`,
            contact
          );
          this.notify();
          await this.sleep(1000);
          continue;
        }

        if (this.abortRequested) break;

        // Step 2: Human Presence Simulation (composing / typing state)
        const typingDuration = getTypingDuration(config.typingMinMs, config.typingMaxMs);
        this.statusMessage = `Simulating typing presence for ${maskedNameStr} (${maskedPhone})...`;
        this.notify();

        try {
          await activeSocket.sendPresenceUpdate('composing', contact.jid);
        } catch (_) {}

        await this.sleep(typingDuration);
        if (this.abortRequested) break;

        // Step 3: Payload Personalization & Entropy Injection
        const { finalPayload, digest } = personalizeMessage(this.messageTemplate, contact, i);

        // Reset presence state
        try {
          await activeSocket.sendPresenceUpdate('paused', contact.jid);
        } catch (_) {}

        if (this.abortRequested) break;

        // Step 4: Dispatch Message
        this.statusMessage = `Dispatching payload [Hash #${digest}] to ${maskedPhone}...`;
        this.notify();

        await activeSocket.sendMessage(contact.jid, { text: finalPayload });

        if (this.abortRequested) break;

        this.sent++;
        this.batchCurrent++;
        this.statusMessage = `Sent to ${maskedNameStr} (${maskedPhone}) [Hash #${digest}]`;
        this.addLog(
          'success',
          `Dispatched to ${maskedNameStr} (${maskedPhone})`,
          contact,
          `#${digest}`
        );
        this.notify();

        // Check if last contact reached
        if (i === this.contacts.length - 1) {
          break;
        }

        if (this.abortRequested) break;

        // Step 5: Micro-Batch Cooldown Check
        if (this.batchCurrent >= this.batchTarget) {
          const cooldownMs = getCooldownDuration(
            config.cooldownDurationMinMs,
            config.cooldownDurationMaxMs
          );
          const cooldownSec = Math.round(cooldownMs / 1000);
          this.status = 'cooldown';
          this.cooldownEndsAt = Date.now() + cooldownMs;
          this.statusMessage = `Micro-batch breather pause: resting for ${cooldownSec}s to prevent rate-limiting...`;
          this.addLog(
            'cooldown',
            `Batch breather initiated: reached ${this.batchCurrent} messages. Cooling down for ${cooldownSec}s...`
          );
          this.notify();

          // Sleep during cooldown while updating countdown
          const cooldownStart = Date.now();
          while (Date.now() - cooldownStart < cooldownMs) {
            if (this.abortRequested) break;
            const remainingCooldownSec = Math.max(0, Math.ceil((cooldownMs - (Date.now() - cooldownStart)) / 1000));
            this.statusMessage = `Micro-batch breather: resting for account safety (${remainingCooldownSec}s remaining)...`;
            this.notify();
            await this.sleep(1000);
          }

          if (this.abortRequested) break;

          // Reset batch counter and determine next threshold
          this.batchCurrent = 0;
          this.batchTarget = getNextBatchThreshold(
            config.cooldownBatchMin,
            config.cooldownBatchMax
          );
          this.cooldownEndsAt = null;
          this.status = 'running';
          this.addLog('info', `Breather complete. Next micro-batch target set to ${this.batchTarget} messages.`);
          this.notify();
        } else {
          // Step 6: Non-Robotic Random Jitter Delay
          const jitterDelayMs = getGaussianJitter(
            config.baseIntervalMs,
            config.jitterMinMs,
            config.jitterMaxMs
          );
          const jitterSec = Math.round(jitterDelayMs / 1000);
          this.addLog(
            'info',
            `Random jitter delay: ${jitterSec}s (${(jitterSec / 60).toFixed(1)}m) randomized gap before next dispatch.`
          );

          // Countdown during jitter delay so operator sees active countdown
          const jitterStart = Date.now();
          while (Date.now() - jitterStart < jitterDelayMs) {
            if (this.abortRequested) break;
            const remainingSec = Math.max(0, Math.ceil((jitterDelayMs - (Date.now() - jitterStart)) / 1000));
            this.statusMessage = `Pacing next message: ${remainingSec}s remaining (${jitterSec}s random jitter)...`;
            this.notify();
            await this.sleep(Math.min(1000, jitterDelayMs - (Date.now() - jitterStart)));
          }
          if (this.abortRequested) break;
        }
      } catch (err: any) {
        if (this.abortRequested) break;
        this.failed++;
        this.statusMessage = `Failed sending to +${contact.phone}: ${err?.message || 'Error'}`;
        this.addLog(
          'error',
          `Failed sending to +${contact.phone} (${contact.name}): ${err?.message || err}`,
          contact
        );
        this.notify();
        // Brief pause after error
        await this.sleep(2000);
        if (this.abortRequested) break;
      }
    }

    if (this.abortRequested) {
      this.status = 'aborted';
      this.statusMessage = 'Broadcast aborted by operator.';
      this.cooldownEndsAt = null;
    } else {
      this.status = 'completed';
      this.statusMessage = `Broadcast completed! Sent ${this.sent} / ${this.total} successfully.`;
      this.completedAt = new Date().toISOString();
      this.addLog(
        'info',
        `Broadcast finished! Sent: ${this.sent}, Skipped: ${this.skipped}, Failed: ${this.failed}.`
      );
    }
    this.currentContact = null;
    this.notify();
  }
}
