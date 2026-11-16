/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import { Server as SocketIOServer } from 'socket.io';

export type WASocketInstance = ReturnType<typeof makeWASocket>;
export type WAConnectionState = 'disconnected' | 'connecting' | 'qr_ready' | 'connected';

export interface WAAccountInfo {
  id: string;
  name: string;
  phone: string;
  connectedAt?: string;
}

export class WhatsAppManager {
  private sock: WASocketInstance | null = null;
  private connectionState: WAConnectionState = 'disconnected';
  private qrCodeDataUrl: string | null = null;
  private qrCodeRaw: string | null = null;
  private qrGeneratedAt: number | null = null;
  private accountInfo: WAAccountInfo | null = null;
  private sessionDir: string;
  private io: SocketIOServer | null = null;
  private isInitializing = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(sessionDir = './wa_auth_session') {
    this.sessionDir = path.resolve(process.cwd(), sessionDir);
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  public setSocketIO(io: SocketIOServer) {
    this.io = io;
  }

  public getSocket(): WASocketInstance | null {
    return this.connectionState === 'connected' ? this.sock : null;
  }

  public getRawSocket(): WASocketInstance | null {
    return this.sock;
  }

  public getState() {
    return {
      connectionState: this.connectionState,
      qrCodeDataUrl: this.qrCodeDataUrl,
      qrGeneratedAt: this.qrGeneratedAt,
      accountInfo: this.accountInfo,
      isInitializing: this.isInitializing,
    };
  }

  private broadcastState() {
    if (this.io) {
      this.io.emit('wa_status', this.getState());
    }
  }

  public async initialize(): Promise<void> {
    if (this.isInitializing) {
      console.log('[WhatsAppManager] Already initializing, skipping redundant trigger.');
      return;
    }

    if (this.connectionState === 'connected' && this.sock) {
      console.log('[WhatsAppManager] Already connected, skipping initialize.');
      return;
    }

    this.isInitializing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      console.log('[WhatsAppManager] Starting WhatsApp socket initialization...');
      this.connectionState = 'connecting';
      this.broadcastState();

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      let version: [number, number, number] = [2, 3000, 1015901307];

      try {
        const fetched = await fetchLatestBaileysVersion();
        if (fetched?.version) {
          version = fetched.version;
        }
      } catch (_) {
        // Fallback default version
      }

      // Cleanup existing socket listeners if any
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
        printQRInTerminal: true, // Also print to terminal for easy CLI scanning
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 2000,
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrCodeRaw = qr;
          this.qrGeneratedAt = Date.now();
          console.log('[WhatsAppManager] QR code received from WhatsApp servers. Rendering PNG data URL...');
          try {
            this.qrCodeDataUrl = await QRCode.toDataURL(qr, {
              margin: 2,
              scale: 8,
              color: {
                dark: '#0f172a',
                light: '#ffffff',
              },
            });
            this.connectionState = 'qr_ready';
            console.log('[WhatsAppManager] QR Ready! Emitting state to frontend.');
            this.broadcastState();
          } catch (qrErr) {
            console.error('[WhatsAppManager] Error rendering QR Code:', qrErr);
          }
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          console.log(`[WhatsAppManager] Connection closed. StatusCode: ${statusCode}, isLoggedOut: ${isLoggedOut}`);

          this.qrCodeDataUrl = null;
          this.qrCodeRaw = null;
          this.accountInfo = null;
          this.connectionState = 'disconnected';
          this.broadcastState();

          if (isLoggedOut) {
            console.log('[WhatsAppManager] Session logged out. Wiping session directory...');
            if (fs.existsSync(this.sessionDir)) {
              fs.rmSync(this.sessionDir, { recursive: true, force: true });
              fs.mkdirSync(this.sessionDir, { recursive: true });
            }
          }

          // Always schedule reconnect so QR is perpetually available until authenticated
          this.isInitializing = false;
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            console.log('[WhatsAppManager] Auto-reconnecting WhatsApp engine for fresh QR...');
            this.initialize();
          }, 2500);

        } else if (connection === 'open') {
          console.log('[WhatsAppManager] WhatsApp session established successfully!');
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }

          this.connectionState = 'connected';
          this.qrCodeDataUrl = null;
          this.qrCodeRaw = null;
          this.qrGeneratedAt = null;

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
      console.error('[WhatsAppManager] Fatal error during WhatsApp init:', err);
      this.connectionState = 'disconnected';
      this.broadcastState();

      // Retry after delay
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.isInitializing = false;
        this.initialize();
      }, 4000);
    } finally {
      this.isInitializing = false;
    }
  }

  public async refreshQR(): Promise<{ success: boolean; qrCodeDataUrl: string | null }> {
    console.log('[WhatsAppManager] Manual QR refresh requested.');
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch (_) {}
      this.sock = null;
    }
    this.connectionState = 'disconnected';
    this.qrCodeDataUrl = null;
    this.broadcastState();

    this.isInitializing = false;
    await this.initialize();

    return {
      success: true,
      qrCodeDataUrl: this.qrCodeDataUrl,
    };
  }

  public async unlink(): Promise<{ success: boolean; message: string }> {
    try {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      if (this.sock) {
        try {
          await this.sock.logout();
        } catch (_) {}
        try {
          this.sock.end(new Error('User unlinked account'));
        } catch (_) {}
        this.sock = null;
      }

      // Remove session folder files
      if (fs.existsSync(this.sessionDir)) {
        fs.rmSync(this.sessionDir, { recursive: true, force: true });
        fs.mkdirSync(this.sessionDir, { recursive: true });
      }

      this.connectionState = 'disconnected';
      this.accountInfo = null;
      this.qrCodeDataUrl = null;
      this.qrCodeRaw = null;
      this.qrGeneratedAt = null;
      this.broadcastState();

      // Automatically re-initialize to generate fresh QR
      setTimeout(() => {
        this.isInitializing = false;
        this.initialize();
      }, 1000);

      return { success: true, message: 'Account unlinked successfully. New QR generated.' };
    } catch (err: any) {
      return { success: false, message: `Failed to unlink: ${err?.message || err}` };
    }
  }
}
