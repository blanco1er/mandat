// Mandat server: account (PayPal login, profile, rules, mandate), missions (each with its own envelope),
// live event stream per mission (SSE), approvals, stop switch, merchant inbox.
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSession, userTurn, resolveApproval, resolveRequest, envelopeView, missionSummary } from './lib/agent.mjs';
import * as PayPal from './lib/paypal.mjs';
import { geocode } from './lib/places.mjs';
import { chat, MODELS } from './lib/deepseek.mjs';
import { newUser, getUser, saveUser, getMission, saveMission, approveAboveFor, agentBrief, monthCommitted, AUTONOMY } from './lib/users.mjs';

const app = express();
const PORT = Number(process.env.PORT || 8790);
const BASE = () => process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const live = new Map(); // missionId -> { s, clients:Set, busy:Promise, log:[] }

app.use(express.json({ limit: '8mb' })); // photos arrive as data URLs
app.use(express.static(path.resolve('public'), { extensions: ['html'] }));

// ---------- account (cookie) ----------
function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function me(req, res) {
  let u = getUser(cookie(req, 'mandat_uid'));
  if (!u) {
    u = newUser();
    saveUser(u);
    res.setHeader('Set-Cookie', `mandat_uid=${u.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  }
  return u;
}
function publicUser(u) {
  const { paypal, ...rest } = u;
  return { ...rest, paypal: { connected: paypal.connected, payerName: paypal.payerName, payerEmail: paypal.payerEmail, verified: paypal.verified, mandate: paypal.mandate ? { active: true, mode: paypal.mandate.mode, signedAt: paypal.mandate.signedAt } : null }, knows: agentBrief(u), autonomyLevels: AUTONOMY };
}

// ---------- missions in memory, persisted after every agent run ----------
function box(id, user) {
  let b = live.get(id);
  if (!b) {
    const s = getMission(id);
    if (!s) throw Object.assign(new Error('Unknown mission'), { status: 404 });
    s.feed ||= []; // the event feed is saved with the mission, so it survives a server restart
    b = { s, clients: new Set(), busy: Promise.resolve(), log: s.feed };
    live.set(id, b);
  }
  if (user && b.s.userId !== user.id) throw Object.assign(new Error('Not your mission'), { status: 403 });
  if (user) b.s._user = user;
  return b;
}
function emitter(b) {
  return (type, data) => {
    const evt = { type, data, at: Date.now() };
    b.log.push(evt);
    if (b.log.length > 400) b.log.shift();
    for (const res of b.clients) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
}
function run(b, fn) {
  const emit = emitter(b);
  b.busy = b.busy.then(async () => {
    b.running = true;
    emit('busy', { on: true });
    try {
      await fn(emit);
    } catch (e) {
      console.error('[agent]', e);
      emit('error', { message: e.message });
    } finally {
      b.running = false;
      emit('busy', { on: false });
      emit('envelope', envelopeView(b.s));
      emit('summary', missionSummary(b.s));
      saveMission(b.s);
    }
  });
  return b.busy;
}
const api = (h) => async (req, res) => {
  try {
    res.json(await h(req, res));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
};

app.get('/api/health', (req, res) => res.json({ ok: true, paypal: PayPal.MODE }));

app.get('/api/me', api(async (req, res) => {
  const u = me(req, res);
  const missions = u.missions.map((id) => getMission(id)).filter(Boolean).map((s) => missionSummary(live.get(s.id)?.s || s));
  return { user: publicUser(u), missions, paypalMode: PayPal.MODE };
}));

app.post('/api/me', api(async (req, res) => {
  const u = me(req, res);
  const { profile, rules, voice } = req.body || {};
  if (profile) {
    const p = u.profile;
    for (const k of ['name', 'email', 'phone', 'diet', 'preferences']) if (typeof profile[k] === 'string') p[k] = profile[k].slice(0, 300);
    if (profile.home === null || (profile.home && typeof profile.home.label === 'string')) p.home = profile.home;
    if (Array.isArray(profile.people)) p.people = profile.people.slice(0, 20).map((x) => ({ name: String(x.name || '').slice(0, 60), contact: String(x.contact || '').slice(0, 120) })).filter((x) => x.name);
  }
  if (rules) {
    if (AUTONOMY[rules.autonomy]) u.rules.autonomy = rules.autonomy;
    for (const k of ['approveAbove', 'monthlyCap', 'dailyCap']) if (Number.isFinite(rules[k]) && rules[k] >= 0 && rules[k] <= 20000) u.rules[k] = rules[k];
  }
  if (voice && typeof voice.on === 'boolean') u.voice.on = voice.on;
  saveUser(u);
  return { user: publicUser(u) };
}));

// Forget everything the agent knows about me (profile), keep PayPal connection and missions.
app.post('/api/me/forget', api(async (req, res) => {
  const u = me(req, res);
  u.profile = newUser().profile;
  saveUser(u);
  return { user: publicUser(u) };
}));

// Stop switch: freezes every mission's payments instantly.
app.post('/api/me/stop', api(async (req, res) => {
  const u = me(req, res);
  u.frozen = !!req.body?.stopped;
  saveUser(u);
  for (const id of u.missions) {
    const b = live.get(id);
    if (b) emitter(b)('stopped', { stopped: u.frozen, scope: 'all' });
  }
  return { user: publicUser(u) };
}));

// ---------- PayPal: log in, then sign the mandate once ----------
app.get('/auth/paypal', (req, res) => {
  const u = me(req, res);
  const state = crypto.randomBytes(8).toString('hex');
  u._state = state;
  res.setHeader('Set-Cookie', [`mandat_uid=${u.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`, `mandat_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`]);
  res.redirect(PayPal.loginUrl({ redirectUri: `${BASE()}/auth/paypal/callback`, state }));
});

app.get('/auth/paypal/callback', async (req, res) => {
  try {
    const u = me(req, res);
    if (String(req.query.state) !== cookie(req, 'mandat_state')) throw new Error('State mismatch');
    const info = await PayPal.loginCallback(String(req.query.code));
    u.paypal.connected = true;
    u.paypal.payerName = info.name;
    u.paypal.payerEmail = info.email;
    u.paypal.verified = info.verified;
    if (!u.profile.name && info.name) u.profile.name = info.name;
    if (!u.profile.email && info.email) u.profile.email = info.email;
    saveUser(u);
    res.redirect('/?connected=1');
  } catch (e) {
    res.status(400).send('PayPal sign-in failed: ' + e.message);
  }
});

app.post('/api/me/mandate', api(async (req, res) => {
  const u = me(req, res);
  const setup = await PayPal.createMandateSetup({
    returnUrl: `${BASE()}/mandate/return`,
    cancelUrl: `${BASE()}/?mandate=cancelled`,
    description: `Mandat — lets your agent hold and pay deposits up to ${u.rules.monthlyCap} EUR a month, inside each mission budget.`,
  });
  u.pendingSetup = setup.id;
  saveUser(u);
  return setup;
}));

app.get('/mandate/return', async (req, res) => {
  try {
    const u = me(req, res);
    const tokenId = String(req.query.approval_token_id || u.pendingSetup || '');
    const m = await PayPal.activateMandate(tokenId);
    u.paypal.mandate = { ...m, signedAt: new Date().toISOString() };
    if (m.payer && !u.paypal.payerEmail) u.paypal.payerEmail = m.payer;
    delete u.pendingSetup;
    saveUser(u);
    res.redirect('/?mandate=active');
  } catch (e) {
    res.status(400).send('Mandate activation failed: ' + e.message);
  }
});

app.post('/api/me/mandate/revoke', api(async (req, res) => {
  const u = me(req, res);
  u.paypal.mandate = null;
  saveUser(u);
  return { user: publicUser(u) };
}));

// ---------- missions ----------
app.post('/api/missions', api(async (req, res) => {
  const u = me(req, res);
  if (!u.paypal.mandate) throw new Error('Sign the PayPal mandate first.');
  if (u.frozen) throw new Error('Mandat is stopped. Resume it in Settings.');
  const { intent = '', budget, emoji = '✦', location = null, image = null } = req.body || {};
  if (!(budget > 0 && budget <= 5000)) throw new Error('Budget must be between 1 and 5000.');
  const used = monthCommitted(u, u.missions.map(getMission));
  if (used + budget > u.rules.monthlyCap) throw new Error(`This would exceed your monthly cap (${u.rules.monthlyCap} €, ${used} € already planned).`);
  const s = createSession({ budget, approveAbove: approveAboveFor(u), purpose: intent.slice(0, 120), location, language: req.headers['accept-language']?.slice(0, 5) || 'en', userId: u.id, emoji });
  s.title = plainTitle(intent); // instant; the AI title replaces it in the background
  u.missions.unshift(s.id);
  saveUser(u);
  s.feed = [];
  saveMission(s);
  const b = { s, clients: new Set(), busy: Promise.resolve(), log: s.feed };
  live.set(s.id, b);
  b.s._user = u;
  emitter(b)('user', { text: intent, image: !!image });
  run(b, (emit) => userTurn(b.s, intent, emit, { image }));
  titleFor(intent).then((t) => {
    if (!t || t === b.s.title) return;
    b.s.title = t;
    saveMission(b.s);
    emitter(b)('title', { title: t });
  });
  return { id: s.id, summary: missionSummary(s) };
}));

// A short, clean mission title (e.g. "Two weeks in Spain"), written by the fast model; plain fallback.
function plainTitle(intent) {
  if (!intent.trim()) return 'Photo mission';
  return intent.replace(/\s+/g, ' ').trim().split(/[,.;:!?]/)[0].slice(0, 40).trim() || 'New mission';
}
async function titleFor(intent) {
  const fallback = plainTitle(intent);
  if (!intent.trim()) return fallback;
  try {
    const { message } = await chat({ model: MODELS.fast, fallback: MODELS.smart, maxTokens: 1500, temperature: 0.3, messages: [{ role: 'user', content: `Give a 2-5 word title, in the same language, for this errand: "${intent.slice(0, 300)}". No quotes, no emoji, no final period.` }] });
    const t = (message.content || '').trim().replace(/^["'«]|["'»]$/g, '').slice(0, 42);
    return t || fallback;
  } catch {
    return fallback;
  }
}

app.get('/api/missions/:id', api(async (req, res) => {
  const u = me(req, res);
  const b = box(req.params.id, u);
  return { summary: missionSummary(b.s), envelope: envelopeView(b.s) };
}));

app.post('/api/missions/:id/messages', api(async (req, res) => {
  const u = me(req, res);
  const b = box(req.params.id, u);
  const text = String(req.body?.text || '').trim().slice(0, 1200);
  const image = typeof req.body?.image === 'string' && req.body.image.startsWith('data:image/') ? req.body.image : null;
  if (!text && !image) throw new Error('Empty message');
  emitter(b)('user', { text, image: !!image });
  run(b, (emit) => userTurn(b.s, text, emit, { image }));
  return { queued: true };
}));

app.post('/api/missions/:id/location', api(async (req, res) => {
  const b = box(req.params.id, me(req, res));
  const { lat, lon, label } = req.body || {};
  if (typeof lat !== 'number' || typeof lon !== 'number') throw new Error('lat/lon required');
  b.s.location = { lat, lon, label: String(label || 'your location').slice(0, 120) };
  return { ok: true };
}));

app.post('/api/missions/:id/stop', api(async (req, res) => {
  const b = box(req.params.id, me(req, res));
  b.s.frozen = !!req.body?.stopped;
  emitter(b)('stopped', { stopped: b.s.frozen, scope: 'mission' });
  emitter(b)('summary', missionSummary(b.s));
  saveMission(b.s);
  return { ok: true };
}));

app.post('/api/missions/:id/approvals/:aid', api(async (req, res) => {
  const b = box(req.params.id, me(req, res));
  run(b, (emit) => resolveApproval(b.s, req.params.aid, !!req.body?.approved, emit));
  return { queued: true };
}));

app.get('/api/missions/:id/events', (req, res) => {
  let b;
  try {
    b = box(req.params.id, me(req, res));
  } catch (e) {
    return res.status(e.status || 400).end();
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  for (const evt of b.log) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'ready', data: { busy: !!b.running } })}\n\n`); // end of the replayed history
  b.clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    b.clients.delete(res);
  });
});

app.get('/api/geocode', api(async (req) => {
  const q = String(req.query.q || '').trim().slice(0, 160);
  if (q.length < 3) throw new Error('Type an address');
  return await geocode(q);
}));

// ---------- merchant inbox (merchants without an AI agent) ----------
app.get('/api/merchants/:mid/requests', api(async (req) => {
  const out = [];
  for (const b of live.values()) for (const r of Object.values(b.s.requests)) if (r.merchant_id === req.params.mid) out.push(r);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}));

app.post('/api/requests/:rid', api(async (req) => {
  for (const b of live.values()) {
    if (b.s.requests[req.params.rid]) {
      if (b.s.userId) b.s._user = getUser(b.s.userId);
      run(b, (emit) => resolveRequest(b.s, req.params.rid, !!req.body?.accepted, emit));
      return { queued: true };
    }
  }
  throw Object.assign(new Error('Unknown request'), { status: 404 });
}));

app.listen(PORT, () => console.log(`Mandat on ${BASE()} (PayPal: ${PayPal.MODE})`));
