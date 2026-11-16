/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useRef } from 'react';
import {
  QrCode,
  Users,
  Send,
  Pause,
  Play,
  Square,
  ShieldCheck,
  RefreshCw,
  LogOut,
  Upload,
  Copy,
  Clock,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Terminal,
  Download,
  Trash2,
  Code2,
} from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import { PacingMode, PACING_MODES_METADATA } from './lib/pacing.ts';

interface WAAccountInfo {
  id: string;
  name: string;
  phone: string;
  connectedAt?: string;
}

interface WAState {
  connectionState: 'disconnected' | 'connecting' | 'qr_ready' | 'connected';
  qrCodeDataUrl: string | null;
  accountInfo: WAAccountInfo | null;
}

interface QueueLog {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warn' | 'error' | 'cooldown';
  message: string;
  digest?: string;
}

interface QueueState {
  status: 'idle' | 'running' | 'paused' | 'cooldown' | 'completed' | 'aborted';
  pacingMode: PacingMode;
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  currentIndex: number;
  statusMessage: string;
  etaFormatted: string;
  cooldownRemainingSeconds: number;
  logs: QueueLog[];
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connectedToSocket, setConnectedToSocket] = useState(false);
  const [waState, setWaState] = useState<WAState>({
    connectionState: 'disconnected',
    qrCodeDataUrl: null,
    accountInfo: null,
  });

  const [queueState, setQueueState] = useState<QueueState>({
    status: 'idle',
    pacingMode: 'balanced',
    total: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    currentIndex: 0,
    statusMessage: 'Queue is idle. Ready to dispatch.',
    etaFormatted: '0s',
    cooldownRemainingSeconds: 0,
    logs: [],
  });

  const [contactsRaw, setContactsRaw] = useState(
    '9800001111, Aman Sharma\n9800002222, Sneha Gupta\n9800003333, Rahul Verma\n9800004444, Priya Patel\n9800005555, Rohit Joshi'
  );
  const [validCount, setValidCount] = useState(5);
  const [duplicateCount, setDuplicateCount] = useState(0);

  const [message, setMessage] = useState(
    'Hello {name}! Join us for the upcoming GDG on Campus session at IET DAVV Indore.\n\nDate: Saturday, 4:00 PM\nRef: {ref}\n\nWe look forward to having you!'
  );
  const [pacingMode, setPacingMode] = useState<PacingMode>('balanced');
  const [showPreview, setShowPreview] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isAborting, setIsAborting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Fetch QR state directly via HTTP
  const fetchQRDirectly = async () => {
    try {
      const res = await fetch('/api/qr');
      if (res.ok) {
        const state = await res.json();
        if (state && (state.qrCodeDataUrl || state.connectionState)) {
          setWaState(state);
        }
      }
    } catch (_) {}
  };

  const handleRefreshQR = async () => {
    try {
      const res = await fetch('/api/qr/refresh', { method: 'POST' });
      if (res.ok) {
        const state = await res.json();
        setWaState(state);
      }
    } catch (_) {}
  };

  // Initialize Socket.io & Polling
  useEffect(() => {
    const s = io({
      reconnectionAttempts: 20,
      reconnectionDelay: 2000,
    });

    s.on('connect', () => {
      setConnectedToSocket(true);
      s.emit('request_state');
    });

    s.on('disconnect', () => {
      setConnectedToSocket(false);
    });

    s.on('wa_status', (state: WAState) => {
      setWaState(state);
    });

    s.on('queue_state', (state: QueueState) => {
      setQueueState(state);
    });

    setSocket(s);

    // Initial fetch
    fetchQRDirectly();

    // Polling fallback
    const interval = setInterval(() => {
      fetchQRDirectly();
    }, 2500);

    return () => {
      s.disconnect();
      clearInterval(interval);
    };
  }, []);

  // Validate contacts input
  useEffect(() => {
    if (!contactsRaw.trim()) {
      setValidCount(0);
      setDuplicateCount(0);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/contacts/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: contactsRaw, max: 800 }),
        });
        if (res.ok) {
          const data = await res.json();
          setValidCount(data.validCount);
          setDuplicateCount(data.duplicatesCount);
        }
      } catch (_) {}
    }, 300);

    return () => clearTimeout(timer);
  }, [contactsRaw]);

  // Insert template tag
  const insertTag = (tag: string) => {
    if (!textareaRef.current) return;
    const start = textareaRef.current.selectionStart;
    const end = textareaRef.current.selectionEnd;
    const updated = message.substring(0, start) + tag + message.substring(end);
    setMessage(updated);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + tag.length;
      }
    }, 10);
  };

  // CSV File upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) setContactsRaw(content);
    };
    reader.readAsText(file);
  };

  // Dispatch Actions
  const handleStartDispatch = async () => {
    if (validCount === 0) {
      setFormError('Please enter at least one valid recipient phone number.');
      return;
    }
    if (!message.trim()) {
      setFormError('Please write a broadcast message.');
      return;
    }
    if (waState.connectionState !== 'connected') {
      setFormError('Please link WhatsApp by scanning the QR code first.');
      return;
    }
    setFormError(null);

    // Primary: WebSocket emit
    if (socket?.connected) {
      socket.emit('start_dispatch', {
        contactsRaw,
        message,
        pacingMode,
      });
    } else {
      // Fallback: REST API
      try {
        await fetch('/api/dispatch/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactsRaw, message, pacingMode }),
        });
      } catch (err) {
        console.error('Dispatch start error:', err);
      }
    }
  };

  const handlePauseToggle = async () => {
    if (queueState.status === 'paused') {
      socket?.emit('resume_dispatch');
      try {
        await fetch('/api/dispatch/resume', { method: 'POST' });
      } catch (_) {}
    } else {
      socket?.emit('pause_dispatch');
      try {
        await fetch('/api/dispatch/pause', { method: 'POST' });
      } catch (_) {}
    }
  };

  // Instant abort without blocking window.confirm which fails inside iframes
  const handleAbort = async () => {
    setIsAborting(true);
    setFormError(null);

    // 1. Instant optimistic state update
    setQueueState((prev) => ({
      ...prev,
      status: 'aborted',
      statusMessage: 'Broadcast aborted by operator.',
    }));

    // 2. Channel 1: WebSocket event
    if (socket) {
      socket.emit('abort_dispatch');
    }

    // 3. Channel 2: Guaranteed REST API endpoint
    try {
      const res = await fetch('/api/dispatch/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.state) {
          setQueueState(data.state);
        }
      }
    } catch (err) {
      console.error('Abort failed via HTTP:', err);
    } finally {
      setTimeout(() => setIsAborting(false), 400);
    }
  };

  const handleResetQueue = async () => {
    socket?.emit('clear_logs');
    try {
      const res = await fetch('/api/dispatch/reset', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.state) {
          setQueueState(data.state);
        }
      }
    } catch (_) {}
  };

  const handleUnlink = async () => {
    setContactsRaw('');
    setValidCount(0);
    setDuplicateCount(0);
    setQueueState((prev) => ({
      ...prev,
      status: 'idle',
      sent: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      logs: [],
      statusMessage: 'Queue is idle. Ready to dispatch.',
    }));

    try {
      await fetch('/api/logs/clear', { method: 'POST' });
      await fetch('/api/auth/unlink', { method: 'POST' });
    } catch (_) {}

    socket?.emit('clear_logs');
    socket?.emit('unlink_wa');
  };

  const handlePurgeLogs = async () => {
    setQueueState((prev) => ({ ...prev, logs: [] }));
    try {
      await fetch('/api/logs/clear', { method: 'POST' });
    } catch (_) {}
    socket?.emit('clear_logs');
  };

  const processedCount = queueState.sent + queueState.skipped + queueState.failed;
  const progressPercent = queueState.total > 0 ? Math.min(100, Math.round((processedCount / queueState.total) * 100)) : 0;

  return (
    <div className="min-h-screen bg-[#080c14] text-slate-100 flex flex-col font-sans selection:bg-emerald-500/30 selection:text-emerald-200">
      {/* Header */}
      <header className="border-b border-slate-800 bg-[#080c14]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-600 via-teal-500 to-emerald-400 p-0.5 shadow-lg shadow-emerald-500/20 flex items-center justify-center">
              <div className="w-full h-full bg-[#080c14] rounded-[10px] flex items-center justify-center">
                <Send className="w-4 h-4 text-emerald-400" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-base tracking-tight text-white">GDG on Campus</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                  IET DAVV Indore
                </span>
              </div>
              <p className="text-xs text-slate-400">Autonomous WhatsApp Smart Broadcast Engine</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-400">
              <Code2 className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-slate-500">Dev:</span>
              <span className="text-slate-200 font-semibold">Sajal Agrawal</span>
            </div>

            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs">
              <span className="relative flex h-2 w-2">
                {connectedToSocket && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>}
                <span className={`relative inline-flex rounded-full h-2 w-2 ${connectedToSocket ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
              </span>
              <span className="font-mono text-slate-300">{connectedToSocket ? 'Live Synced' : 'Connecting...'}</span>
            </div>

            {(queueState.status === 'running' || queueState.status === 'cooldown' || queueState.status === 'paused') && (
              <button
                onClick={handleAbort}
                className="px-3 py-1.5 rounded-lg bg-red-950/40 text-red-400 border border-red-800/40 hover:bg-red-900/60 transition text-xs font-medium flex items-center gap-1.5"
              >
                <Square className="w-3.5 h-3.5" />
                Abort Dispatch
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Anti-Abuse Shield Banner */}
        <div className="rounded-xl bg-gradient-to-r from-emerald-950/30 via-slate-900 to-blue-950/30 border border-emerald-500/20 p-4 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 mt-0.5">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Smart Anti-Abnormality Rate-Limit Engine Active</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Dispatches up to 800 contacts across 1–2 hours using Gaussian non-robotic jitter, human typing presence simulation (1.2s–2.5s), micro-batch breathers (45s–75s every ~45 msgs), and invisible zero-width cryptographic hash variations.
              </p>
            </div>
          </div>
          <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300 shrink-0">
            Baileys WebSocket Multi-Device
          </span>
        </div>

        {/* 3-Card Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Card 1: Account Link */}
          <section className="lg:col-span-4 flex flex-col">
            <div className="bg-[#131d31] border border-slate-800 rounded-2xl p-6 shadow-xl flex-1 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
                  <div className="flex items-center gap-2.5">
                    <span className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-xs flex items-center justify-center border border-emerald-500/30">
                      1
                    </span>
                    <h3 className="text-sm font-bold text-white tracking-wide">Account Link</h3>
                  </div>
                  <span
                    className={`text-xs font-mono px-2.5 py-0.5 rounded-full border ${
                      waState.connectionState === 'connected'
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                        : waState.connectionState === 'qr_ready'
                        ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                        : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                    }`}
                  >
                    {waState.connectionState === 'connected'
                      ? 'Connected'
                      : waState.connectionState === 'qr_ready'
                      ? 'Scan QR'
                      : 'Connecting...'}
                  </span>
                </div>

                {waState.connectionState === 'connected' ? (
                  <div className="space-y-6 pt-4">
                    <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-500/30 flex items-center gap-4">
                      <div className="w-14 h-14 rounded-full bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center text-white text-xl font-bold shadow-lg shadow-emerald-500/20">
                        {waState.accountInfo?.name?.[0]?.toUpperCase() || 'W'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                          <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Active Device</span>
                        </div>
                        <h4 className="text-base font-bold text-white truncate mt-0.5">
                          {waState.accountInfo?.name || 'Connected User'}
                        </h4>
                        <p className="text-xs font-mono text-slate-400 truncate">
                          +{waState.accountInfo?.phone || 'WhatsApp Account'}
                        </p>
                      </div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-[#0b1120] border border-slate-800 space-y-2 text-xs">
                      <div className="flex justify-between text-slate-400">
                        <span>Engine:</span>
                        <span className="font-mono text-slate-200">Baileys WebSocket</span>
                      </div>
                      <div className="flex justify-between text-slate-400">
                        <span>Multi-File Auth:</span>
                        <span className="text-emerald-400 font-medium">Encrypted &amp; Persistent</span>
                      </div>
                      <div className="flex justify-between text-slate-400">
                        <span>Rate Limit Guard:</span>
                        <span className="text-emerald-400 font-medium">Gaussian Stochastic</span>
                      </div>
                    </div>

                    <button
                      onClick={handleUnlink}
                      className="w-full py-2.5 px-4 rounded-xl bg-red-950/30 text-red-400 border border-red-800/40 hover:bg-red-900/50 hover:text-red-300 transition text-xs font-medium flex items-center justify-center gap-2"
                    >
                      <LogOut className="w-4 h-4" />
                      Unlink WhatsApp Account
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="relative w-64 h-64 mx-auto bg-white p-3 rounded-2xl shadow-2xl flex items-center justify-center border border-slate-700 overflow-hidden">
                      {waState.qrCodeDataUrl ? (
                        <img
                          src={waState.qrCodeDataUrl}
                          className="w-full h-full object-contain"
                          alt="WhatsApp QR Code"
                        />
                      ) : (
                        <div className="flex flex-col items-center justify-center text-slate-800 space-y-2">
                          <RefreshCw className="animate-spin h-8 w-8 text-emerald-600" />
                          <span className="text-xs font-medium text-slate-600">Generating QR...</span>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col items-center gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={handleRefreshQR}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-medium transition cursor-pointer active:scale-95"
                      >
                        <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Refresh QR Code</span>
                      </button>
                      <span className="text-[10px] text-slate-500 font-mono">Live auto-refresh active</span>
                    </div>

                    <div className="space-y-2 text-center text-xs text-slate-400 pt-1">
                      <p className="font-medium text-slate-200">How to link your WhatsApp:</p>
                      <ol className="text-left space-y-1.5 pl-4 list-decimal text-slate-400">
                        <li>Open WhatsApp on your mobile phone</li>
                        <li>
                          Tap <strong className="text-slate-300">Settings</strong> &gt;{' '}
                          <strong className="text-slate-300">Linked Devices</strong>
                        </li>
                        <li>
                          Tap <strong className="text-slate-300">Link a Device</strong> and point your camera here
                        </li>
                      </ol>
                      <p className="text-[11px] text-slate-500 pt-1">
                        Session persists automatically in <code className="text-emerald-400">./wa_auth_session</code> across restarts.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-6 border-t border-slate-800/50 text-[11px] text-slate-500 flex items-center justify-between">
                <span>Server: Node.js Express</span>
                <span className="text-emerald-500 font-mono">Port 3000</span>
              </div>
            </div>
          </section>

          {/* Card 2: Recipients & Message */}
          <section className="lg:col-span-4 flex flex-col">
            <div className="bg-[#131d31] border border-slate-800 rounded-2xl p-6 shadow-xl flex-1 flex flex-col justify-between space-y-5">
              <div className="space-y-5">
                <div className="flex items-center justify-between pb-4 border-b border-slate-800">
                  <div className="flex items-center gap-2.5">
                    <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 font-bold text-xs flex items-center justify-center border border-blue-500/30">
                      2
                    </span>
                    <h3 className="text-sm font-bold text-white tracking-wide">Recipients &amp; Message</h3>
                  </div>
                  <button
                    onClick={() => {
                      const demo = Array.from({ length: 50 }, (_, i) => `${9800000000 + i * 1111}, Member ${i + 1}`).join('\n');
                      setContactsRaw(demo);
                    }}
                    className="text-xs px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                  >
                    Load Demo (50)
                  </button>
                </div>

                {/* Contacts Input */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <div>
                      <label className="font-semibold text-slate-300">Recipient Phone Numbers</label>
                      <span className="text-[10px] text-slate-400 block font-normal">Space-separated ("9800000001" "9800000002" ...), newlines, or CSV</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileUpload}
                        accept=".csv,.txt"
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1 font-medium"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Upload CSV / TXT
                      </button>
                    </div>
                  </div>

                  <textarea
                    rows={5}
                    value={contactsRaw}
                    onChange={(e) => setContactsRaw(e.target.value)}
                    placeholder="Paste numbers (up to 800 contacts)&#10;Formats: Space-separated (&quot;First&quot; &quot;Second&quot; ... or 9876543210 9876543211 ...), newlines, or CSV (9876543210, Name)"
                    className="w-full bg-[#0b1120] border border-slate-800 rounded-xl p-3 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 resize-none custom-scrollbar"
                  />

                  <div className="flex items-center justify-between text-xs">
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-mono text-[11px] border border-emerald-500/30">
                      {validCount} valid numbers detected (Max 800)
                    </span>
                    {duplicateCount > 0 && (
                      <span className="text-[11px] text-amber-400">{duplicateCount} duplicates filtered</span>
                    )}
                  </div>
                </div>

                {/* Message Composer */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <label className="font-semibold text-slate-300">Message Content</label>
                    <button
                      type="button"
                      onClick={() => setShowPreview(!showPreview)}
                      className="text-[11px] text-emerald-400 hover:text-emerald-300 font-medium"
                    >
                      {showPreview ? 'Edit Message' : 'Preview Sample'}
                    </button>
                  </div>

                  {/* Template placeholder pills */}
                  <div className="flex flex-wrap gap-1.5 pb-1">
                    {['{name}', '{greeting}', '{phone}', '{time}', '{ref}'].map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => insertTag(tag)}
                        className="text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 font-mono"
                      >
                        + {tag}
                      </button>
                    ))}
                  </div>

                  {showPreview ? (
                    <div className="h-[120px] bg-[#0b1120] border border-emerald-500/40 rounded-xl p-3 text-xs overflow-y-auto custom-scrollbar">
                      <div className="text-[11px] text-emerald-400 font-semibold pb-1 mb-1 border-b border-slate-800">
                        Dynamic Sample Preview (Recipient: Aman Sharma)
                      </div>
                      <div className="text-slate-200 whitespace-pre-wrap font-sans">
                        {message
                          .replace(/\{name\}/gi, 'Aman Sharma')
                          .replace(/\{first_name\}/gi, 'Aman')
                          .replace(/\{phone\}/gi, '919800001111')
                          .replace(/\{greeting\}/gi, 'Hello')
                          .replace(/\{ref\}/gi, 'GDG-4E2A')}
                      </div>
                    </div>
                  ) : (
                    <textarea
                      ref={textareaRef}
                      rows={5}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="Write your broadcast message here..."
                      className="w-full bg-[#0b1120] border border-slate-800 rounded-xl p-3 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 resize-none custom-scrollbar"
                    />
                  )}

                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>{message.length} chars • {message.trim() ? message.trim().split(/\s+/).length : 0} words</span>
                    <span className="text-slate-400">Unique hash per recipient</span>
                  </div>
                </div>

                {/* Pacing Selector */}
                <div className="space-y-3 pt-2 border-t border-slate-800">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-semibold text-slate-300">
                      Pacing Window &amp; Anti-Ban Engine
                    </label>
                    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-950/40 text-emerald-400 border border-emerald-800/40">
                      <ShieldCheck className="w-3 h-3 text-emerald-400" />
                      Anti-Suspension Guard Active
                    </span>
                  </div>

                  {/* 6-Mode Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-1.5">
                    {PACING_MODES_METADATA.map((p) => {
                      const isSelected = pacingMode === p.mode;
                      return (
                        <button
                          key={p.mode}
                          type="button"
                          onClick={() => setPacingMode(p.mode)}
                          className={`p-2 rounded-xl border text-center transition flex flex-col items-center relative overflow-hidden ${
                            isSelected
                              ? 'border-emerald-500/60 bg-emerald-950/30 shadow-md shadow-emerald-500/10'
                              : 'border-slate-800 bg-[#0b1120] hover:border-slate-600'
                          }`}
                        >
                          {p.badgeText && (
                            <span
                              className={`text-[9px] font-semibold px-1.5 py-0.2 rounded-full border mb-1 ${
                                p.badgeClass || 'bg-slate-800 text-slate-300 border-slate-700'
                              }`}
                            >
                              {p.badgeText}
                            </span>
                          )}
                          <span
                            className={`text-xs font-bold flex items-center gap-1 ${
                              isSelected ? 'text-emerald-300' : 'text-slate-300'
                            }`}
                          >
                            {p.name}
                            {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>}
                          </span>
                          <span className="text-[10px] text-slate-400 mt-0.5 font-medium">{p.window}</span>
                          <span className="text-[9px] text-slate-500 font-mono mt-0.5">{p.baseIntervalDesc.split(' ')[0]} base</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Dynamic Safety & Human Simulation Breakdown Card */}
                  {(() => {
                    const currentMeta = PACING_MODES_METADATA.find((m) => m.mode === pacingMode);
                    if (!currentMeta) return null;
                    const isUltraOrGuardian = pacingMode === 'ultra_safe' || pacingMode === 'guardian_8h' || pacingMode === 'over_safe';

                    return (
                      <div
                        className={`p-3 rounded-xl border text-xs space-y-1.5 transition-all ${
                          isUltraOrGuardian
                            ? 'bg-gradient-to-r from-amber-950/20 via-emerald-950/20 to-cyan-950/20 border-emerald-500/40'
                            : 'bg-[#0b1120] border-slate-800'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                            <ShieldCheck
                              className={`w-4 h-4 ${
                                isUltraOrGuardian ? 'text-emerald-400' : 'text-slate-400'
                              }`}
                            />
                            <span>{currentMeta.name} Profile ({currentMeta.window})</span>
                            <span className="text-[10px] text-slate-400 font-normal">
                              • {currentMeta.safetyLevel}
                            </span>
                          </div>
                          {pacingMode === 'over_safe' && (
                            <span className="text-[10px] font-bold text-emerald-300 bg-emerald-950/60 px-2 py-0.5 rounded-full border border-emerald-500/40 animate-pulse">
                              360s - 514s Random Jitter
                            </span>
                          )}
                          {pacingMode === 'guardian_8h' && (
                            <span className="text-[10px] font-bold text-amber-300 bg-amber-950/60 px-2 py-0.5 rounded-full border border-amber-500/40 animate-pulse">
                              0% Suspension Risk
                            </span>
                          )}
                          {pacingMode === 'ultra_safe' && (
                            <span className="text-[10px] font-bold text-cyan-300 bg-cyan-950/60 px-2 py-0.5 rounded-full border border-cyan-500/40">
                              Stealth Shield (4h)
                            </span>
                          )}
                        </div>

                        <p className="text-[11px] text-slate-300 leading-relaxed">
                          {currentMeta.description}
                        </p>

                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1 border-t border-slate-800/80 text-[10px] text-slate-400 font-mono">
                          <div>
                            <span className="text-slate-500 block">Jitter Timing:</span>
                            <span className="text-slate-200">{currentMeta.baseIntervalDesc}</span>
                          </div>
                          <div>
                            <span className="text-slate-500 block">Human Breathers:</span>
                            <span className="text-slate-200">{currentMeta.cooldownDesc}</span>
                          </div>
                          <div className="col-span-2 sm:col-span-1">
                            <span className="text-slate-500 block">Account Safety:</span>
                            <span className={isUltraOrGuardian ? 'text-emerald-400 font-semibold' : 'text-slate-300'}>
                              {currentMeta.suspensionRisk}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          </section>

          {/* Card 3: 1-Click Dispatch & Monitor */}
          <section className="lg:col-span-4 flex flex-col">
            <div className="bg-[#131d31] border border-slate-800 rounded-2xl p-6 shadow-xl flex-1 flex flex-col justify-between space-y-6">
              <div className="space-y-6">
                <div className="flex items-center justify-between pb-4 border-b border-slate-800">
                  <div className="flex items-center gap-2.5">
                    <span className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-xs flex items-center justify-center border border-emerald-500/30">
                      3
                    </span>
                    <h3 className="text-sm font-bold text-white tracking-wide">1-Click Dispatch &amp; Monitor</h3>
                  </div>
                  <span
                    className={`text-xs font-mono px-2.5 py-0.5 rounded-full border ${
                      queueState.status === 'running'
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                        : queueState.status === 'cooldown'
                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                        : queueState.status === 'paused'
                        ? 'bg-blue-500/20 text-blue-300 border-blue-500/30'
                        : queueState.status === 'aborted'
                        ? 'bg-red-500/20 text-red-300 border-red-500/30'
                        : 'bg-slate-800 text-slate-400 border-slate-700'
                    }`}
                  >
                    {queueState.status.toUpperCase()}
                  </span>
                </div>

                {formError && (
                  <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center justify-between">
                    <span className="font-medium">{formError}</span>
                    <button
                      type="button"
                      onClick={() => setFormError(null)}
                      className="text-amber-400 hover:text-amber-200 text-xs font-bold px-1"
                    >
                      ✕
                    </button>
                  </div>
                )}

                {/* Primary Button */}
                {queueState.status === 'running' || queueState.status === 'cooldown' || queueState.status === 'paused' ? (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={handlePauseToggle}
                      className="py-3 px-4 rounded-xl bg-amber-950/40 text-amber-300 border border-amber-800/40 hover:bg-amber-900/60 transition text-xs font-bold flex items-center justify-center gap-1.5"
                    >
                      {queueState.status === 'paused' ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                      <span>{queueState.status === 'paused' ? 'Resume Queue' : 'Pause Queue'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleAbort}
                      disabled={isAborting}
                      className="py-3 px-4 rounded-xl bg-red-950/50 text-red-300 border border-red-800/60 hover:bg-red-900/80 active:scale-95 transition text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm shadow-red-900/30 disabled:opacity-50"
                    >
                      <Square className="w-4 h-4 text-red-400" />
                      <span>{isAborting ? 'Aborting...' : 'Abort Dispatch'}</span>
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleStartDispatch}
                    disabled={waState.connectionState !== 'connected' || validCount === 0}
                    className="w-full py-4 px-6 rounded-xl bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-500 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-sm tracking-wide shadow-lg shadow-emerald-600/30 transition transform active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:pointer-events-none"
                  >
                    <Send className="w-5 h-5 text-white" />
                    <span>{queueState.status === 'aborted' ? 'Restart / New Dispatch' : 'Start 1-Click Dispatch'}</span>
                  </button>
                )}

                {/* Aborted Banner with Quick Reset */}
                {queueState.status === 'aborted' && (
                  <div className="p-3 rounded-xl bg-red-950/30 border border-red-500/40 text-xs flex items-center justify-between">
                    <div className="flex items-center gap-2 text-red-300 font-medium">
                      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
                      <span>Broadcast aborted ({queueState.sent} sent, {Math.max(0, queueState.total - (queueState.sent + queueState.skipped + queueState.failed))} left)</span>
                    </div>
                    <button
                      type="button"
                      onClick={handleResetQueue}
                      className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-[11px] font-mono transition"
                    >
                      Reset Queue
                    </button>
                  </div>
                )}

                {/* Progress Bar */}
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="font-semibold text-slate-300">Broadcast Progress</span>
                    <span className="font-mono text-emerald-400 font-bold">{progressPercent}%</span>
                  </div>
                  <div className="w-full h-3 bg-[#0b1120] rounded-full overflow-hidden p-0.5 border border-slate-800">
                    <div
                      className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-300"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-4 gap-2">
                  <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-2.5 text-center">
                    <div className="text-[10px] text-slate-400 uppercase font-medium">Sent</div>
                    <div className="text-base font-bold text-white font-mono mt-0.5">{queueState.sent}</div>
                    <div className="text-[9px] text-slate-500 font-mono">/ {queueState.total}</div>
                  </div>
                  <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-2.5 text-center">
                    <div className="text-[10px] text-slate-400 uppercase font-medium">Skipped</div>
                    <div className="text-base font-bold text-amber-400 font-mono mt-0.5">{queueState.skipped}</div>
                    <div className="text-[9px] text-slate-500">Not on WA</div>
                  </div>
                  <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-2.5 text-center">
                    <div className="text-[10px] text-slate-400 uppercase font-medium">Failed</div>
                    <div className="text-base font-bold text-red-400 font-mono mt-0.5">{queueState.failed}</div>
                    <div className="text-[9px] text-slate-500">Errors</div>
                  </div>
                  <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-2.5 text-center">
                    <div className="text-[10px] text-slate-400 uppercase font-medium">ETA Left</div>
                    <div className="text-base font-bold text-emerald-400 font-mono mt-0.5">{queueState.etaFormatted}</div>
                    <div className="text-[9px] text-slate-500">Paced window</div>
                  </div>
                </div>

                {/* Status Message */}
                <div className="p-3.5 rounded-xl bg-[#0b1120] border border-slate-800 flex items-start gap-3">
                  <span className="relative flex h-3 w-3 mt-0.5 shrink-0">
                    {(queueState.status === 'running' || queueState.status === 'cooldown') && (
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    )}
                    <span
                      className={`relative inline-flex rounded-full h-3 w-3 ${
                        queueState.status === 'cooldown'
                          ? 'bg-amber-400'
                          : queueState.status === 'running'
                          ? 'bg-emerald-400'
                          : 'bg-slate-500'
                      }`}
                    ></span>
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Engine State</div>
                    <div className="text-xs text-slate-200 font-medium truncate mt-0.5">{queueState.statusMessage}</div>
                  </div>
                </div>

                {/* Cooldown Breather Alert */}
                {queueState.status === 'cooldown' && (
                  <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-500/40 text-xs space-y-1">
                    <div className="flex items-center justify-between text-amber-300 font-semibold">
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-4 h-4 animate-spin" />
                        Anti-Ban Batch Breather
                      </span>
                      <span className="font-mono text-amber-200 font-bold">
                        {queueState.cooldownRemainingSeconds}s remaining
                      </span>
                    </div>
                    <p className="text-[11px] text-amber-400/80">
                      Taking an automated break to prevent rate-limiting. Queue will resume automatically.
                    </p>
                  </div>
                )}
              </div>

              <div className="pt-4 border-t border-slate-800/50 text-[11px] text-slate-500 flex items-center justify-between">
                <span>Runs autonomously in background</span>
                <span className="text-slate-400">Safe tab close/reload</span>
              </div>
            </div>
          </section>
        </div>

        {/* Real-Time Console Log */}
        <section className="bg-[#131d31] border border-slate-800 rounded-2xl p-5 shadow-xl space-y-3">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-500"></div>
              <h3 className="text-sm font-bold text-white tracking-wide">Live Real-Time Activity Log</h3>
              <span className="text-xs text-slate-400 font-mono">({queueState.logs.length} events)</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-950/40 text-emerald-400 border border-emerald-800/40 flex items-center gap-1 font-sans">
                <ShieldCheck className="w-3 h-3" />
                Privacy Masked
              </span>

              <button
                onClick={() => {
                  if (queueState.logs.length === 0) return;
                  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(queueState.logs, null, 2));
                  const a = document.createElement('a');
                  a.href = dataStr;
                  a.download = `broadcast-log-${Date.now()}.json`;
                  a.click();
                }}
                className="text-xs px-2.5 py-1 rounded-lg bg-[#0b1120] hover:bg-slate-800 text-slate-300 border border-slate-800 transition flex items-center gap-1 font-mono"
              >
                <Download className="w-3.5 h-3.5" />
                Export Log
              </button>

              <button
                onClick={handlePurgeLogs}
                className="text-xs px-2.5 py-1 rounded-lg bg-[#0b1120] hover:bg-red-950/40 hover:text-red-300 hover:border-red-800/40 text-slate-400 border border-slate-800 transition font-mono flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Purge Logs
              </button>
            </div>
          </div>

          <div className="h-48 overflow-y-auto font-mono text-xs space-y-1.5 p-3 rounded-xl bg-[#0b1120] border border-slate-800/80 custom-scrollbar">
            {queueState.logs.length === 0 ? (
              <div className="text-slate-500 italic">Waiting for queue activity...</div>
            ) : (
              queueState.logs.map((l) => (
                <div key={l.id} className="flex items-start gap-2 text-slate-300 hover:bg-slate-800/40 p-1 rounded transition">
                  <span className="text-slate-500 shrink-0 select-none">[{l.timestamp}]</span>
                  <span
                    className={`px-1.5 py-0.2 rounded text-[10px] uppercase font-semibold shrink-0 ${
                      l.level === 'success'
                        ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/40'
                        : l.level === 'warn'
                        ? 'bg-amber-950/60 text-amber-400 border border-amber-800/40'
                        : l.level === 'error'
                        ? 'bg-red-950/60 text-red-400 border border-red-800/40'
                        : l.level === 'cooldown'
                        ? 'bg-cyan-950/60 text-cyan-400 border border-cyan-800/40'
                        : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {l.level}
                  </span>
                  <span className="flex-1 break-all">
                    {l.message} {l.digest && <span className="text-slate-500 text-[10px]">({l.digest})</span>}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 pt-8 pb-10 mt-12 bg-[#080c14]/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 pb-6 border-b border-slate-800/60">
            {/* Left: Project & Organization */}
            <div className="flex items-center gap-3 text-center md:text-left">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20 shrink-0">
                <span className="font-mono text-sm">GDG</span>
              </div>
              <div>
                <div className="flex items-center justify-center md:justify-start gap-2">
                  <h4 className="font-bold text-sm text-white">Google Developer Groups on Campus</h4>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                    IET DAVV Indore
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">Autonomous WhatsApp Smart Broadcast Engine • Safe Multi-Device Architecture</p>
              </div>
            </div>

            {/* Right: Professional Developer Credit Card */}
            <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-[#0b1120] border border-slate-800 shadow-sm hover:border-emerald-500/30 transition">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
                <Code2 className="w-4 h-4" />
              </div>
              <div className="text-left">
                <div className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">Website Developed by</div>
                <div className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5">
                  <span>Sajal Agrawal</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block"></span>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Bar */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
            <p>
              &copy; {new Date().getFullYear()} <strong>GDG on Campus IET DAVV Indore</strong>. Website developed by <span className="text-slate-300 font-medium">Sajal Agrawal</span>.
            </p>
            <div className="flex items-center gap-3 text-[11px] font-mono text-slate-400">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                Anti-Ban Safeguards
              </span>
              <span>•</span>
              <span>Zero-Telemetry Privacy</span>
              <span>•</span>
              <span>Baileys Engine</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
