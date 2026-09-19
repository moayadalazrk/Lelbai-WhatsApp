import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { fileURLToPath } from 'url';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_DIR = path.join(__dirname, 'auth_sessions');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5001;
const LIVE_BRIDGE_URL = (process.env.LIVE_BRIDGE_URL || 'https://api.lelbai.com/public/bridge.php').replace(/\/+$/, '');
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'lelbai_bridge_secure_key_2026_9984';
const LOCAL_BACKEND_URL = process.env.LOCAL_BACKEND_URL || 'http://127.0.0.1:8000';

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Session metadata state: id -> { id, name, phone, isStandby }
const sessionMeta = new Map();

// Currently active running session state
let currentActiveId = 'session_1';
let activeSock = null;
let activeStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
let activePhone = null;
let activeQr = null;
let activePairingCode = null;
let activeLastError = null;
let activeStats = { received: 0, sent: 0, connectedAt: null };
let isStartingSession = false;

function extractMessageContent(msg) {
  if (!msg || !msg.message) return '';
  const m = msg.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.ephemeralMessage?.message?.conversation ||
    m.ephemeralMessage?.message?.extendedTextMessage?.text ||
    m.ephemeralMessage?.message?.imageMessage?.caption ||
    m.viewOnceMessage?.message?.conversation ||
    m.viewOnceMessage?.message?.extendedTextMessage?.text ||
    m.viewOnceMessageV2?.message?.conversation ||
    m.viewOnceMessageV2?.message?.extendedTextMessage?.text ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  );
}

function getSenderPhone(msg, remoteJid, connectedPhone) {
  if (msg.key?.fromMe) {
    return connectedPhone || (remoteJid ? remoteJid.split('@')[0].split(':')[0] : '');
  }
  if (msg.key?.participantPn) return msg.key.participantPn.split('@')[0].split(':')[0];
  if (msg.key?.remoteJidPn) return msg.key.remoteJidPn.split('@')[0].split(':')[0];
  if (msg.key?.senderPn) return msg.key.senderPn.split('@')[0].split(':')[0];

  const jid = remoteJid || msg.key?.remoteJid || '';
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) {
    return jid.split('@')[0].split(':')[0];
  }
  const participant = msg.key?.participant || msg.participant || '';
  if (participant.endsWith('@s.whatsapp.net') || participant.endsWith('@c.us')) {
    return participant.split('@')[0].split(':')[0];
  }
  return jid.split('@')[0].split(':')[0];
}

function formatWhatsAppPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('09') && digits.length === 10) return '963' + digits.substring(1);
  if (digits.startsWith('05') && digits.length === 10) return '966' + digits.substring(1);
  if (digits.startsWith('963') || digits.startsWith('966')) return digits;
  if (digits.length >= 8) return digits;
  return null;
}

function loadSessionsFromDisk() {
  try {
    const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    const sessionDirs = entries.filter(e => e.isDirectory()).map(e => e.name);

    sessionMeta.clear();
    if (sessionDirs.length > 0) {
      sessionDirs.forEach((dir, idx) => {
        sessionMeta.set(dir, {
          id: dir,
          name: idx === 0 ? 'الرقم الأساسي (1)' : `الرقم الاحتياطي (#${dir.replace('session_', '')})`,
          phone: null,
          isStandby: idx !== 0,
        });
      });
      currentActiveId = sessionDirs[0];
    } else {
      sessionMeta.set('session_1', {
        id: 'session_1',
        name: 'الرقم الأساسي (1)',
        phone: null,
        isStandby: false,
      });
      currentActiveId = 'session_1';
    }
  } catch (e) {
    sessionMeta.clear();
    sessionMeta.set('session_1', {
      id: 'session_1',
      name: 'الرقم الأساسي (1)',
      phone: null,
      isStandby: false,
    });
    currentActiveId = 'session_1';
  }
}

loadSessionsFromDisk();

/**
 * Start monitoring and running ONLY the single active session
 */
async function startActiveSession(sessionId, preserveQr = true) {
  if (isStartingSession) return;
  isStartingSession = true;

  try {
    if (!sessionId) {
      if (activeSock) {
        try {
          activeSock.ev.removeAllListeners('connection.update');
          activeSock.ev.removeAllListeners('creds.update');
          activeSock.ev.removeAllListeners('messages.upsert');
          activeSock.end();
        } catch (e) {}
        activeSock = null;
      }
      currentActiveId = null;
      activeStatus = 'disconnected';
      activePhone = null;
      activeQr = null;
      activePairingCode = null;
      isStartingSession = false;
      return;
    }

    currentActiveId = sessionId;
    const sessionFolder = path.join(SESSIONS_DIR, sessionId);
    if (!fs.existsSync(sessionFolder)) {
      fs.mkdirSync(sessionFolder, { recursive: true });
    }

    // Close previous socket if open
    if (activeSock) {
      try {
        activeSock.ev.removeAllListeners('connection.update');
        activeSock.ev.removeAllListeners('creds.update');
        activeSock.ev.removeAllListeners('messages.upsert');
        activeSock.end();
      } catch (e) {}
      activeSock = null;
    }

    if (!preserveQr) {
      activeQr = null;
    }
    activeStatus = activeQr ? 'qr_ready' : 'connecting';
    activeLastError = null;

    console.log(`🔌 [Active Monitor] Initializing session: ${sessionId} (PreserveQR: ${preserveQr && !!activeQr})`);

    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

    // Latest version detection with solid modern fallback
    let version = [2, 3000, 1043857760];
    try {
      const v = await fetchLatestBaileysVersion().catch(() => null);
      if (v?.version) version = v.version;
    } catch (e) {}

    const logger = pino({ level: 'silent' });

    activeSock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 25000,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: true,
      logger,
      retryRequestDelayMs: 250,
    });

    activeSock.ev.on('creds.update', saveCreds);

    // Inbound Messages Listener
    activeSock.ev.on('messages.upsert', async (m) => {
      try {
        const messages = m.messages || [];
        for (const msg of messages) {
          if (!msg.message) continue;
          const remoteJid = msg.key.remoteJid || '';
          if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') continue;

          if (msg.key) {
            try {
              await activeSock.readMessages([msg.key]);
            } catch (readErr) {}
          }

          const senderPhone = getSenderPhone(msg, remoteJid, activePhone);
          const text = extractMessageContent(msg);
          if (!text.trim()) continue;

          activeStats.received++;
          console.log(`📩 [Active Number ${activePhone || sessionId}] Inbound message from ${senderPhone}: "${text}"`);

          const webhookPayload = {
            sender_phone: senderPhone,
            phone: senderPhone,
            message_body: text,
            message: text,
            session_id: sessionId,
            bot_phone: activePhone,
          };

          // Fast direct relay to Bridge on Hostinger
          let webhookResult = null;
          const tStart = Date.now();

          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);

            const bridgeRes = await fetch('https://api.lelbai.com/public/bridge.php?action=inbound-webhook', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Bridge-Secret': BRIDGE_SECRET,
              },
              body: JSON.stringify(webhookPayload),
              signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (bridgeRes.ok) {
              webhookResult = await bridgeRes.json();
            }
          } catch (err) {
            console.error(`Bridge webhook error for ${senderPhone}:`, err.message);
          }

          const durationMs = Date.now() - tStart;
          console.log(`⚡ [Inbound Webhook in ${durationMs}ms] Verification status:`, webhookResult?.verified ? 'VERIFIED ✅' : 'RECORDED 📝');
        }
      } catch (upsertErr) {
        console.error('Error handling upsert message:', upsertErr);
      }
    });

    // Connection lifecycle
    activeSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          activeQr = await QRCode.toDataURL(qr);
          activeStatus = 'qr_ready';
          console.log(`📱 [QR Code Ready] Session ${sessionId} QR code ready for scanning.`);
          syncHeartbeatToBridge();
        } catch (err) {
          console.error('Error generating QR code:', err);
        }
      }

      if (connection === 'open') {
        activeStatus = 'connected';
        activeQr = null;
        activePairingCode = null;
        activeStats.connectedAt = new Date();
        const userJid = activeSock?.user?.id || '';
        activePhone = userJid.split(':')[0]?.split('@')[0]?.replace(/\D/g, '') || 'متصل';
        
        const meta = sessionMeta.get(sessionId) || { id: sessionId };
        meta.phone = activePhone;
        sessionMeta.set(sessionId, meta);

        console.log(`✅ [Active WhatsApp Number] Connected successfully: +${activePhone} (${sessionId})`);
        syncHeartbeatToBridge();
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isRestartReq = statusCode === DisconnectReason.restartRequired;

        console.log(`❌ [Active WhatsApp Connection Closed] Code: ${statusCode} (LoggedOut: ${isLoggedOut}, RestartRequired: ${isRestartReq})`);

        if (isLoggedOut) {
          activeStatus = 'disconnected';
          activeQr = null;
          activePairingCode = null;
          activePhone = null;
          try {
            if (fs.existsSync(sessionFolder)) {
              fs.rmSync(sessionFolder, { recursive: true, force: true });
            }
          } catch (e) {}
          const meta = sessionMeta.get(sessionId);
          if (meta) {
            meta.phone = null;
            sessionMeta.set(sessionId, meta);
          }
          syncHeartbeatToBridge();

          setTimeout(() => {
            if (currentActiveId === sessionId) {
              startActiveSession(sessionId, false);
            }
          }, 2000);
        } else if (isRestartReq) {
          // Restart immediately (Handshake completed by mobile QR scan)
          console.log(`🔄 [QR Handshake Finalizing] Restart required (515) - Reconnecting immediately...`);
          startActiveSession(sessionId, true);
        } else {
          // Normal background reconnect / refresh
          if (activeStatus === 'connected') {
            activeStatus = 'connecting';
            syncHeartbeatToBridge();
            handleFailoverToNextSession(sessionId, false);
          } else {
            // Keep QR in UI and reconnect smoothly
            setTimeout(() => {
              if (currentActiveId === sessionId && activeStatus !== 'connected') {
                startActiveSession(sessionId, true);
              }
            }, 3000);
          }
        }
      }
    });

  } catch (err) {
    console.error(`Failed to start session ${sessionId}:`, err);
    activeStatus = 'disconnected';
    activeLastError = err.message;
    syncHeartbeatToBridge();
    setTimeout(() => {
      if (currentActiveId === sessionId) {
        startActiveSession(sessionId, false);
      }
    }, 4000);
  } finally {
    isStartingSession = false;
  }
}

/**
 * Switch automatically to the next available backup session upon failure
 */
function handleFailoverToNextSession(failedSessionId, isLoggedOut) {
  const allIds = Array.from(sessionMeta.keys());
  const otherIds = allIds.filter(id => id !== failedSessionId);

  if (otherIds.length > 0) {
    const nextSessionId = otherIds[0];
    console.log(`⚡ [Failover] Session ${failedSessionId} disconnected! Switching automatically to standby: ${nextSessionId}`);
    setTimeout(() => {
      startActiveSession(nextSessionId, false);
    }, 2000);
  } else {
    setTimeout(() => {
      startActiveSession(failedSessionId, false);
    }, 3000);
  }
}

// 🚀 1. Send Heartbeat to Live Bridge on Hostinger every 15 seconds
async function syncHeartbeatToBridge() {
  try {
    const allSessions = Array.from(sessionMeta.values()).map(s => {
      const isActive = s.id === currentActiveId;
      return {
        id: s.id,
        name: s.name,
        phone: isActive ? activePhone : s.phone,
        is_active: isActive,
        status: isActive ? activeStatus : 'standby',
        qr: isActive ? activeQr : null,
        pairing_code: isActive ? activePairingCode : null,
      };
    });

    const payload = {
      status: activeStatus,
      active_session_id: currentActiveId,
      phone: activePhone,
      qr: activeQr,
      pairing_code: activePairingCode,
      sessions: allSessions,
      uptime: process.uptime(),
    };

    await fetch('https://api.lelbai.com/public/bridge.php?action=heartbeat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Secret': BRIDGE_SECRET,
      },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch (err) {}
}

// 🚀 2. Poll Pending Outbox Queue from Live Bridge every 3.5 seconds and dispatch OTPs
async function pollAndDispatchBridgeQueue() {
  if (activeStatus !== 'connected' || !activeSock) return;

  try {
    const res = await fetch(`${LIVE_BRIDGE_URL}?action=pending-queue`, {
      headers: {
        'X-Bridge-Secret': BRIDGE_SECRET,
      },
    });
    if (!res.ok) return;

    const data = await res.json();
    const outbox = data.outbox_queue || [];

    for (const item of outbox) {
      const formatted = formatWhatsAppPhone(item.phone);
      if (!formatted) continue;

      const targetJid = `${formatted}@s.whatsapp.net`;
      const messageText = `${item.code} هو رمز تاكيد حسابك على منصة للبيع`;

      try {
        await activeSock.sendMessage(targetJid, { text: messageText });
        activeStats.sent++;
        console.log(`🚀 [Bridge Dispatch] Sent OTP code ${item.code} to ${formatted}`);

        // Mark sent
        await fetch(`${LIVE_BRIDGE_URL}?action=mark-sent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bridge-Secret': BRIDGE_SECRET,
          },
          body: JSON.stringify({ id: item.id }),
        }).catch(() => {});
      } catch (sendErr) {
        console.error(`Failed to dispatch OTP to ${formatted}:`, sendErr.message);
      }
    }
  } catch (err) {}
}

// Start polling & heartbeat intervals
setInterval(syncHeartbeatToBridge, 15000);
setInterval(pollAndDispatchBridgeQueue, 3500);

// Start primary session on launch
if (currentActiveId) {
  startActiveSession(currentActiveId, false);
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// API 1: Status of Active Monitored Number & Standby Pool
app.get('/status', (req, res) => {
  const allSessions = Array.from(sessionMeta.values()).map(s => {
    const isActive = s.id === currentActiveId;
    return {
      id: s.id,
      name: s.name,
      is_active: isActive,
      status: isActive ? activeStatus : 'standby',
      phone: isActive ? activePhone : s.phone,
      qr: isActive ? activeQr : null,
      pairing_code: isActive ? activePairingCode : null,
      error: isActive ? activeLastError : null,
      messagesReceived: isActive ? activeStats.received : 0,
      messagesSent: isActive ? activeStats.sent : 0,
    };
  });

  return res.json({
    status: activeStatus,
    active_session_id: currentActiveId,
    phone: activePhone,
    qr: activeQr,
    pairing_code: activePairingCode,
    error: activeLastError,
    total_configured_numbers: allSessions.length,
    sessions: allSessions,
  });
});

// API 2: List all session configurations
app.get('/sessions', (req, res) => {
  const allSessions = Array.from(sessionMeta.values()).map(s => ({
    id: s.id,
    name: s.name,
    is_active: s.id === currentActiveId,
    status: s.id === currentActiveId ? activeStatus : 'standby',
    phone: s.id === currentActiveId ? activePhone : s.phone,
    qr: s.id === currentActiveId ? activeQr : null,
    pairing_code: s.id === currentActiveId ? activePairingCode : null,
  }));

  return res.json({
    success: true,
    active_session_id: currentActiveId,
    sessions: allSessions,
  });
});

// API 3: Add a new backup/standby number
app.post('/sessions/create', async (req, res) => {
  try {
    const customName = req.body.name || null;
    const existingIds = Array.from(sessionMeta.keys());
    let nextNum = existingIds.length + 1;
    let newId = `session_${nextNum}`;
    while (sessionMeta.has(newId)) {
      nextNum++;
      newId = `session_${nextNum}`;
    }

    const sessionName = customName || (existingIds.length === 0 ? 'الرقم الأساسي (1)' : `الرقم الاحتياطي #${nextNum}`);
    sessionMeta.set(newId, {
      id: newId,
      name: sessionName,
      phone: null,
      isStandby: existingIds.length > 0
    });

    startActiveSession(newId, false);

    return res.json({
      success: true,
      message: `تم إضافة (${sessionName}) وجاري مراقبته وتوليد الباركود.`,
      session_id: newId,
      name: sessionName,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// API 4: Request 8-Digit Pairing Code for Active Session
app.post('/sessions/:id/pairing-code', async (req, res) => {
  const { id } = req.params;
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, message: 'رقم الهاتف مطلوب لتوليد كود الربط.' });
  }

  const formatted = formatWhatsAppPhone(phone);
  if (!formatted) {
    return res.status(422).json({
      success: false,
      message: 'رقم الهاتف غير صالح. يرجى إدخال رقم صحيح (مثال: 0912345678 أو 0512345678 أو 963912345678).'
    });
  }

  if (currentActiveId !== id || !activeSock) {
    await startActiveSession(id, false);
    await new Promise(r => setTimeout(r, 1200));
  }

  if (activeStatus === 'connected') {
    return res.json({
      success: true,
      already_connected: true,
      message: `الحساب متصل بالفعل برقم +${activePhone}`,
      phone: activePhone,
    });
  }

  try {
    console.log(`📲 [Pairing Code Request] Requesting pairing code for +${formatted}...`);
    const rawCode = await activeSock.requestPairingCode(formatted);
    // Format nicely as ABCD-EFGH
    const code = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
    activePairingCode = code;
    console.log(`🔑 [Pairing Code Generated] +${formatted} => ${code}`);

    syncHeartbeatToBridge();

    return res.json({
      success: true,
      pairing_code: code,
      raw_code: rawCode,
      phone: formatted,
      message: `تم توليد رمز الربط بنجاح: ${code}`,
      instructions: [
        '1. افتح تطبيق واتساب على هاتفك 📱',
        '2. اضغط على خيارات (الثلاث نقاط) ➡️ الأجهزة المرتبطة',
        '3. اضغط على "ربط جهاز" ➡️ ثم اضغط على "الربط برقم الهاتف بدلاً من ذلك"',
        `4. أدخل هذا الرمز: ${code}`
      ]
    });
  } catch (err) {
    console.error('Error requesting pairing code:', err);
    return res.status(500).json({
      success: false,
      message: 'فشل توليد رمز الربط: ' + err.message
    });
  }
});

// Shortcut for pairing code without session ID
app.post('/pairing-code', async (req, res) => {
  const sessionId = currentActiveId || 'session_1';
  req.url = `/sessions/${sessionId}/pairing-code`;
  req.params = { id: sessionId };
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, message: 'رقم الهاتف مطلوب لتوليد كود الربط.' });
  }

  const formatted = formatWhatsAppPhone(phone);
  if (!formatted) {
    return res.status(422).json({
      success: false,
      message: 'رقم الهاتف غير صالح. يرجى إدخال رقم صحيح (مثال: 0912345678 أو 0512345678 أو 963912345678).'
    });
  }

  if (!activeSock) {
    await startActiveSession(sessionId, false);
    await new Promise(r => setTimeout(r, 1200));
  }

  if (activeStatus === 'connected') {
    return res.json({
      success: true,
      already_connected: true,
      message: `الحساب متصل بالفعل برقم +${activePhone}`,
      phone: activePhone,
    });
  }

  try {
    const rawCode = await activeSock.requestPairingCode(formatted);
    const code = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
    activePairingCode = code;
    syncHeartbeatToBridge();

    return res.json({
      success: true,
      pairing_code: code,
      raw_code: rawCode,
      phone: formatted,
      message: `تم توليد رمز الربط بنجاح: ${code}`,
      instructions: [
        '1. افتح تطبيق واتساب على هاتفك 📱',
        '2. اضغط على خيارات (الثلاث نقاط) ➡️ الأجهزة المرتبطة',
        '3. اضغط على "ربط جهاز" ➡️ ثم اضغط على "الربط برقم الهاتف بدلاً من ذلك"',
        `4. أدخل هذا الرمز: ${code}`
      ]
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'فشل توليد رمز الربط: ' + err.message });
  }
});

// API 5: Switch Active Monitored Session
app.post('/sessions/:id/activate', async (req, res) => {
  const { id } = req.params;
  if (!sessionMeta.has(id)) {
    return res.status(404).json({ success: false, message: 'الحساب غير موجود.' });
  }

  startActiveSession(id, false);
  return res.json({
    success: true,
    message: `تم تعيين (${sessionMeta.get(id).name}) كرقم فعّال يتم مراقبته الآن.`,
  });
});

// API 6: Restart Active Session
app.post('/sessions/:id/restart', async (req, res) => {
  const { id } = req.params;
  startActiveSession(id, false);
  return res.json({ success: true, message: 'تمت إعادة تشغيل الجلسة بنجاح.' });
});

// API 7: Delete Session (Completely remove and wipe)
app.delete('/sessions/:id', async (req, res) => {
  const { id } = req.params;
  if (!sessionMeta.has(id)) {
    return res.status(404).json({ success: false, message: 'الحساب غير موجود.' });
  }

  if (currentActiveId === id && activeSock) {
    try {
      activeSock.ev.removeAllListeners('connection.update');
      activeSock.ev.removeAllListeners('creds.update');
      activeSock.ev.removeAllListeners('messages.upsert');
      activeSock.end();
    } catch (e) {}
    activeSock = null;
  }

  const sessionFolder = path.join(SESSIONS_DIR, id);
  if (fs.existsSync(sessionFolder)) {
    try {
      fs.rmSync(sessionFolder, { recursive: true, force: true });
    } catch (e) {
      console.error(`Error deleting session folder ${id}:`, e.message);
    }
  }

  sessionMeta.delete(id);

  if (currentActiveId === id) {
    activePhone = null;
    activeQr = null;
    activePairingCode = null;
    activeLastError = null;
    const remaining = Array.from(sessionMeta.keys());
    if (remaining.length > 0) {
      currentActiveId = remaining[0];
      startActiveSession(currentActiveId, false);
    } else {
      currentActiveId = null;
      activeStatus = 'disconnected';
    }
  }

  syncHeartbeatToBridge();

  return res.json({
    success: true,
    message: 'تم حذف الحساب والجلسة بنجاح.',
    remaining_sessions: sessionMeta.size
  });
});

// API 8: Logout Session
app.post('/sessions/:id/logout', async (req, res) => {
  const { id } = req.params;
  if (!sessionMeta.has(id)) {
    return res.status(404).json({ success: false, message: 'الحساب غير موجود.' });
  }

  if (currentActiveId === id && activeSock) {
    try {
      await activeSock.logout().catch(() => {});
      activeSock.ev.removeAllListeners('connection.update');
      activeSock.ev.removeAllListeners('creds.update');
      activeSock.ev.removeAllListeners('messages.upsert');
      activeSock.end();
    } catch (e) {}
    activeSock = null;
  }

  const sessionFolder = path.join(SESSIONS_DIR, id);
  if (fs.existsSync(sessionFolder)) {
    try {
      fs.rmSync(sessionFolder, { recursive: true, force: true });
    } catch (e) {}
  }

  const meta = sessionMeta.get(id);
  if (meta) {
    meta.phone = null;
    sessionMeta.set(id, meta);
  }

  if (currentActiveId === id) {
    activePhone = null;
    activeQr = null;
    activePairingCode = null;
    activeStatus = 'disconnected';
  }

  syncHeartbeatToBridge();

  return res.json({ success: true, message: 'تم تسجيل الخروج وفصل الحساب بنجاح.' });
});

app.post('/logout', async (req, res) => {
  if (currentActiveId) {
    if (activeSock) {
      try {
        await activeSock.logout().catch(() => {});
        activeSock.end();
      } catch (e) {}
      activeSock = null;
    }
    const sessionFolder = path.join(SESSIONS_DIR, currentActiveId);
    if (fs.existsSync(sessionFolder)) {
      try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch (e) {}
    }
    activePhone = null;
    activeQr = null;
    activePairingCode = null;
    activeStatus = 'disconnected';
    syncHeartbeatToBridge();
  }
  return res.json({ success: true, message: 'تم تسجيل الخروج بنجاح.' });
});

// API 9: Check Number on WhatsApp
app.post('/check-number', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ exists: false, message: 'رقم الهاتف مطلوب.' });

  const formatted = formatWhatsAppPhone(phone);
  if (!formatted) return res.status(422).json({ exists: false, message: 'رقم الهاتف غير صالح.' });

  if (activeStatus !== 'connected' || !activeSock) {
    return res.status(503).json({ exists: false, message: 'الرقم الفعّال غير متصل حالياً.' });
  }

  try {
    const jid = `${formatted}@s.whatsapp.net`;
    const results = await activeSock.onWhatsApp(jid);
    if (results && results.length > 0 && results[0].exists) {
      return res.json({
        exists: true,
        phone: phone,
        jid: results[0].jid,
        message: 'الرقم مسجل على واتساب.',
        checked_by: activePhone,
      });
    } else {
      return res.status(422).json({
        exists: false,
        phone: phone,
        message: 'الرقم غير مسجل على واتساب.',
      });
    }
  } catch (err) {
    return res.status(500).json({ exists: false, message: 'حدث خطأ أثناء فحص الرقم.' });
  }
});

// API 10: Send OTP via Active Number
app.post('/send-otp', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ message: 'رقم الجوال ورمز التحقق مطلوبان.' });

  const formatted = formatWhatsAppPhone(phone);
  if (!formatted) return res.status(422).json({ message: 'رقم الجوال غير صالح.' });

  if (activeStatus !== 'connected' || !activeSock) {
    return res.status(503).json({ message: 'خادم الواتساب غير متصل حالياً.' });
  }

  try {
    const targetJid = `${formatted}@s.whatsapp.net`;
    const messageText = `${code} هو رمز تاكيد حسابك على منصة للبيع`;

    await activeSock.sendMessage(targetJid, { text: messageText });
    activeStats.sent++;
    return res.json({
      success: true,
      message: 'تم إرسال رمز التحقق بنجاح.',
      sent_via: activePhone,
    });
  } catch (err) {
    return res.status(500).json({ message: 'فشل إرسال الرسالة عبر الواتساب.' });
  }
});

// Web Dashboard
app.get('/', (req, res) => {
  const isConnected = activeStatus === 'connected';
  const isQrReady = activeStatus === 'qr_ready' && activeQr;

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>خادم واتساب منصة للبيع | WhatsApp Gateway</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .card {
      background: #1e293b;
      border-radius: 16px;
      padding: 32px;
      width: 100%;
      max-width: 500px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
      text-align: center;
      border: 1px solid #334155;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 20px;
    }
    .badge-connected { background: #064e3b; color: #34d399; }
    .badge-qr { background: #78350f; color: #fbbf24; }
    .badge-disconnected { background: #7f1d1d; color: #f87171; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; }
    h1 { font-size: 20px; margin: 0 0 8px 0; color: #f8fafc; }
    p { color: #94a3b8; font-size: 14px; margin: 0 0 24px 0; }
    .qr-container {
      background: #ffffff;
      padding: 16px;
      border-radius: 12px;
      display: inline-block;
      margin-bottom: 16px;
    }
    .qr-container img { display: block; width: 200px; height: 200px; }
    .info-box {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 14px;
      font-size: 13px;
      color: #cbd5e1;
      text-align: right;
      margin-bottom: 20px;
    }
    .info-row { display: flex; justify-content: space-between; padding: 4px 0; }
    .info-label { color: #64748b; }
    .btn {
      background: #2563eb;
      color: #ffffff;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
    }
    .btn:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge ${isConnected ? 'badge-connected' : isQrReady ? 'badge-qr' : 'badge-disconnected'}">
      <span class="dot"></span>
      ${isConnected ? 'متصل وجاهز للعمل' : isQrReady ? 'بانتظار الربط (QR أو رمز الهاتف)' : 'جاري تهيئة الاتصال...'}
    </div>
    
    <h1>بوابة واتساب منصة للبيع</h1>
    <p>امسح الرمز من تطبيق واتساب أو اطلب كود الربط المباشر 📱</p>

    ${isConnected ? `
      <div style="font-size: 48px; margin-bottom: 16px;">✅</div>
      <p style="color: #34d399; font-weight: bold; font-size: 18px;">الرقم المتصل: +${activePhone}</p>
    ` : isQrReady ? `
      <div class="qr-container">
        <img src="${activeQr}" alt="QR Code" />
      </div>
      <div style="font-size: 12px; color: #94a3b8; margin-bottom: 16px;">امسح الكود من: واتساب ⬅️ الأجهزة المرتبطة ⬅️ ربط جهاز</div>
    ` : `
      <div style="padding: 40px; color: #94a3b8;">جاري توليد الباركود... يرجى الانتظار</div>
    `}

    <div class="info-box">
      <div class="info-row"><span class="info-label">حالة السيرفر:</span><span>${activeStatus}</span></div>
      <div class="info-row"><span class="info-label">الرقم النشط:</span><span>${activePhone ? '+' + activePhone : 'غير متصل'}</span></div>
      <div class="info-row"><span class="info-label">الجلسة:</span><span>${currentActiveId}</span></div>
      <div class="info-row"><span class="info-label">رابط الجسر الحي:</span><span>${LIVE_BRIDGE_URL}</span></div>
    </div>

    <button onclick="window.location.reload()" class="btn">🔄 تحديث الحالة</button>
  </div>
</body>
</html>`;
  return res.send(html);
});

// API 11: Health check
app.get('/health', (req, res) => {
  return res.json({
    status: 'ok',
    active_session: currentActiveId,
    active_status: activeStatus,
    active_phone: activePhone,
    total_configured: sessionMeta.size,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Active-Standby Gateway running on port ${PORT}`);
  console.log(`🔗 Connected with Live Bridge: https://api.lelbai.com/public/bridge.php`);
});