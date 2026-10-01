// Mandat server: sessions, live event stream (SSE), user approvals, merchant inbox, PayPal mandate return.
import express from 'express';
import path from 'node:path';
import { createSession, userTurn, resolveApproval, resolveRequest, envelopeView } from './lib/agent.mjs';
import * as PayPal from './lib/paypal.mjs';

const app = express();
const PORT = Number(process.env.PORT || 8790);
const sessions = new Map(); // id -> { s, clients:Set<res>, busy:Promise, log:[] }

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.resolve('public'), { extensions: ['html'] }));

function box(id) {
  const b = sessions.get(id);
  if (!b) throw Object.assign(new Error('Unknown session'), { status: 404 });
  return b;
}

// Every event goes to the live stream and to a replay log (a reconnecting screen catches up).
function emitter(b) {
  return (type, data) => {
    const evt = { type, data, at: Date.now() };
    b.log.push(evt);
    for (const res of b.clients) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
}

// One agent action at a time per session; the UI shows "thinking" meanwhile.
function run(b, fn) {
  const emit = emitter(b);
  b.busy = b.busy.then(async () => {
    emit('busy', { on: true });
    try {
      await fn(emit);
    } catch (e) {
      console.error('[agent]', e);
      emit('error', { message: e.message });
    } finally {
      emit('busy', { on: false });
      emit('envelope', envelopeView(b.s));
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

app.post('/api/sessions', api(async (req) => {
  const { budget, approveAbove = 50, currency = 'EUR', purpose = '', location = null, language = 'en' } = req.body || {};
  if (!(budget > 0 && budget <= 5000)) throw new Error('Budget must be between 1 and 5000.');
  const s = createSession({ budget, approveAbove, currency, purpose, location, language });
  sessions.set(s.id, { s, clients: new Set(), busy: Promise.resolve(), log: [] });
  return { id: s.id, envelope: envelopeView(s), paypal: PayPal.MODE };
}));

// Sign the mandate: returns the PayPal URL where the user saves PayPal once.
app.post('/api/sessions/:id/mandate', api(async (req) => {
  const b = box(req.params.id);
  const base = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  const setup = await PayPal.createMandateSetup({
    returnUrl: `${base}/mandate/return?session=${b.s.id}`,
    cancelUrl: `${base}/?session=${b.s.id}&mandate=cancelled`,
    description: `Mandat — up to ${b.s.envelope.total} ${b.s.envelope.currency} for: ${b.s.envelope.purpose || 'your plan'}`,
  });
  b.s.pendingSetup = setup.id;
  return setup;
}));

// PayPal sends the user back here after approving the mandate.
app.get('/mandate/return', async (req, res) => {
  try {
    const b = box(String(req.query.session));
    const tokenId = String(req.query.approval_token_id || b.s.pendingSetup || '');
    const m = await PayPal.activateMandate(tokenId);
    b.s.mandate = m;
    emitter(b)('mandate', { active: true, mode: m.mode });
    res.redirect(`/?session=${b.s.id}&mandate=active`);
  } catch (e) {
    res.status(400).send('Mandate activation failed: ' + e.message);
  }
});

app.post('/api/sessions/:id/messages', api(async (req) => {
  const b = box(req.params.id);
  const text = String(req.body?.text || '').trim().slice(0, 1200);
  if (!text) throw new Error('Empty message');
  emitter(b)('user', { text });
  run(b, (emit) => userTurn(b.s, text, emit));
  return { queued: true };
}));

app.post('/api/sessions/:id/location', api(async (req) => {
  const b = box(req.params.id);
  const { lat, lon, label } = req.body || {};
  if (typeof lat !== 'number' || typeof lon !== 'number') throw new Error('lat/lon required');
  b.s.location = { lat, lon, label: String(label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`).slice(0, 120) };
  return { ok: true };
}));

app.post('/api/sessions/:id/approvals/:aid', api(async (req) => {
  const b = box(req.params.id);
  run(b, (emit) => resolveApproval(b.s, req.params.aid, !!req.body?.approved, emit));
  return { queued: true };
}));

app.get('/api/sessions/:id/events', (req, res) => {
  const b = box(req.params.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  for (const evt of b.log) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  b.clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    b.clients.delete(res);
  });
});

// Merchant inbox (merchants without an AI agent): list and answer booking requests with one tap.
app.get('/api/merchants/:mid/requests', api(async (req) => {
  const out = [];
  for (const b of sessions.values()) for (const r of Object.values(b.s.requests)) if (r.merchant_id === req.params.mid) out.push(r);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}));

app.post('/api/requests/:rid', api(async (req) => {
  for (const b of sessions.values()) {
    if (b.s.requests[req.params.rid]) {
      run(b, (emit) => resolveRequest(b.s, req.params.rid, !!req.body?.accepted, emit));
      return { queued: true };
    }
  }
  throw Object.assign(new Error('Unknown request'), { status: 404 });
}));

app.listen(PORT, () => console.log(`Mandat on http://localhost:${PORT} (PayPal: ${PayPal.MODE})`));
