/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';

import { WhatsAppManager } from './src/lib/whatsapp.ts';
import { DispatchQueue } from './src/lib/queue.ts';
import { parseContacts, sanitizePhoneNumber } from './src/lib/sanitizer.ts';
import { PacingMode } from './src/lib/pacing.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Serve static frontend assets from public/
const publicDir = path.resolve(__dirname, 'public');
app.use(express.static(publicDir));

// Initialize WhatsApp and Queue Singletons
const waManager = new WhatsAppManager('./wa_auth_session');
waManager.setSocketIO(io);

const dispatchQueue = new DispatchQueue(() => waManager.getSocket());
dispatchQueue.setOnStateChange((queueState) => {
  io.emit('queue_state', queueState);
});

// Socket.io Client Synchronization
io.on('connection', (socket) => {
  // Immediately sync current states with new client
  socket.emit('wa_status', waManager.getState());
  socket.emit('queue_state', dispatchQueue.getState());

  socket.on('request_state', () => {
    socket.emit('wa_status', waManager.getState());
    socket.emit('queue_state', dispatchQueue.getState());
  });

  socket.on('start_dispatch', async (data: { contactsRaw: string; message: string; pacingMode: PacingMode }) => {
    const { contactsRaw, message, pacingMode = 'balanced' } = data;
    const { contacts } = parseContacts(contactsRaw, 800);
    const result = await dispatchQueue.start(contacts, message, pacingMode);
    socket.emit('dispatch_action_result', result);
  });

  socket.on('pause_dispatch', () => {
    const res = dispatchQueue.pause();
    socket.emit('dispatch_action_result', res);
  });

  socket.on('resume_dispatch', () => {
    const res = dispatchQueue.resume();
    socket.emit('dispatch_action_result', res);
  });

  socket.on('abort_dispatch', () => {
    const res = dispatchQueue.abort();
    socket.emit('dispatch_action_result', res);
  });

  socket.on('clear_logs', () => {
    dispatchQueue.clearLogs();
  });

  socket.on('unlink_wa', async () => {
    dispatchQueue.reset(true);
    const res = await waManager.unlink();
    socket.emit('unlink_result', res);
  });
});

// REST API Endpoints
app.get('/api/status', (_req: Request, res: Response) => {
  res.json({
    whatsapp: waManager.getState(),
    queue: dispatchQueue.getState(),
    serverTime: new Date().toISOString(),
  });
});

app.post('/api/contacts/validate', (req: Request, res: Response) => {
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

app.post('/api/dispatch/start', async (req: Request, res: Response) => {
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

app.post('/api/dispatch/pause', (_req: Request, res: Response) => {
  const result = dispatchQueue.pause();
  io.emit('queue_state', dispatchQueue.getState());
  res.json({ ...result, state: dispatchQueue.getState() });
});

app.post('/api/dispatch/resume', (_req: Request, res: Response) => {
  const result = dispatchQueue.resume();
  io.emit('queue_state', dispatchQueue.getState());
  res.json({ ...result, state: dispatchQueue.getState() });
});

app.post('/api/dispatch/abort', (_req: Request, res: Response) => {
  const result = dispatchQueue.abort();
  io.emit('queue_state', dispatchQueue.getState());
  res.json({ ...result, state: dispatchQueue.getState() });
});

app.post('/api/dispatch/reset', (_req: Request, res: Response) => {
  dispatchQueue.reset(true);
  io.emit('queue_state', dispatchQueue.getState());
  res.json({ success: true, message: 'Queue and logs wiped from memory', state: dispatchQueue.getState() });
});

app.post('/api/logs/clear', (_req: Request, res: Response) => {
  dispatchQueue.clearLogs();
  res.json({ success: true, message: 'Activity logs purged' });
});

app.post('/api/auth/unlink', async (_req: Request, res: Response) => {
  dispatchQueue.reset(true);
  const result = await waManager.unlink();
  res.json(result);
});

// QR Code API Endpoints (Direct HTTP Fallback)
app.get('/api/qr', (_req: Request, res: Response) => {
  const state = waManager.getState();
  // If disconnected or not initialized, trigger background init
  if (state.connectionState === 'disconnected') {
    waManager.initialize().catch(console.error);
  }
  res.json(state);
});

app.post('/api/qr/refresh', async (_req: Request, res: Response) => {
  const result = await waManager.refreshQR();
  res.json({
    ...result,
    ...waManager.getState(),
  });
});

// Fallback to public/index.html for SPA routing
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.resolve(publicDir, 'index.html'));
});

// Launch Server on port 3000
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`[GDG WhatsApp Broadcast] Server running on port ${PORT}`);
  console.log(`[GDG WhatsApp Broadcast] Dashboard available at http://localhost:${PORT}`);

  // Initiate WhatsApp Baileys connection on boot
  waManager.initialize().catch((err) => {
    console.error('[GDG WhatsApp Broadcast] Initial WhatsApp boot error:', err);
  });
});

export { app, server, waManager, dispatchQueue };
