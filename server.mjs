// Mandat server: account (PayPal login, profile, rules, mandate), missions (each with its own envelope),
// live event stream per mission (SSE), approvals, stop switch, merchant inbox.
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createSession, userTurn, resolveApproval, resolveRequest, captureEntry, envelopeView, missionSummary, wrapCard, autoReminders } from './lib/agent.mjs';
import * as PayPal from './lib/paypal.mjs';
import { geocode } from './lib/places.mjs';
import { chat, MODELS, probe } from './lib/deepseek.mjs';
import { invoiceStatus } from './lib/invoices.mjs';
import { ics, planEvents, validTz, localToUtc } from './lib/calendar.mjs';
import { KINDS } from './lib/memory.mjs';
import { emojiFor, isEmoji } from './lib/emoji.mjs';
import { budgetFromText } from './lib/budget.mjs';
import * as Push from './lib/push.mjs';
import { tr, trn, langOf, money } from './lib/i18n-server.mjs';
import { merchant, checkInbox } from './lib/merchants.mjs';
import { newUser, getUser, saveUser, getMission, saveMission, deleteMission, approveAboveFor, agentBrief, monthCommitted, AUTONOMY } from './lib/users.mjs';

const app = express();
const PORT = Number(process.env.PORT || 8790);
const BASE = () => process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`; // Render provides RENDER_EXTERNAL_URL
const live = new Map(); // missionId -> { s, clients:Set, busy:Promise, log:[] }

app.set('trust proxy', 1); // behind Render / a tunnel: the client IP is in X-Forwarded-For
app.use(express.json({ limit: '3mb' })); // photos arrive as data URLs, resized to 1280 px by the app

// The app sends the person's time zone and interface language: reminders and "tomorrow at 5" are understood
// in the first, notifications and the agent's replies follow the second.
app.use('/api', (req, res, next) => {
  const tz = req.get('X-TZ');
  const lang = req.get('X-Lang');
  const okTz = tz && validTz(tz), okLang = lang === 'fr' || lang === 'en';
  if (okTz || okLang) {
    const u = getUser(cookie(req, 'mandat_uid'));
    if (u && ((okTz && u.tz !== tz) || (okLang && u.lang !== lang))) {
      if (okTz) u.tz = tz;
      if (okLang) u.lang = lang;
      saveUser(u);
    }
  }
  next();
});
const reqLang = (req) => langOf(req.get('X-Lang'));

// ---------- protections for a public demo (keeps the AI bill bounded until judging ends) ----------
// Short burst limit per IP on every write.
const bursts = new Map();
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const b = bursts.get(ip)?.filter((t) => now - t < 60000) || [];
  if (b.length >= Number(process.env.MANDAT_WRITES_PER_MINUTE || 40)) return res.status(429).json({ error: 'Too many requests — wait a minute and try again.' });
  b.push(now);
  bursts.set(ip, b);
  if (bursts.size > 5000) bursts.clear();
  next();
});
// Daily AI allowance: per person and for the whole app (each agent turn or ledger question counts once).
const LIMITS = { turns: Number(process.env.MANDAT_TURNS_PER_USER_DAY || 80), missions: Number(process.env.MANDAT_MISSIONS_PER_USER_DAY || 15), global: Number(process.env.MANDAT_TURNS_PER_DAY || 3000) };
let usage = { day: '', global: 0, users: new Map() };
function allowance(u, kind = 'turns') {
  const day = new Date().toISOString().slice(0, 10);
  if (usage.day !== day) usage = { day, global: 0, users: new Map() };
  const mine = usage.users.get(u.id) || { turns: 0, missions: 0 };
  if (usage.global >= LIMITS.global) throw Object.assign(new Error(tr(u.lang, 'Mandat has reached its daily demo limit. Please come back tomorrow.')), { status: 429 });
  if (mine[kind] >= LIMITS[kind]) throw Object.assign(new Error(kind === 'missions' ? tr(u.lang, "That's {n} new missions today, the demo limit. Continue an existing one, or come back tomorrow.", { n: LIMITS.missions }) : tr(u.lang, "You reached today's demo limit for the AI. It resets at midnight (UTC).")), { status: 429 });
  mine[kind]++;
  if (kind === 'turns') usage.global++;
  usage.users.set(u.id, mine);
}
app.use(express.static(path.resolve('public'), { extensions: ['html'] }));
// The budget reader is shared with the app, so both understand "40 € each for 4" the same way.
app.get('/budget.mjs', (req, res) => res.type('text/javascript').sendFile(path.resolve('lib/budget.mjs')));

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
  const { paypal, push, ...rest } = u;
  return { ...rest, notifications: (push || []).length, paypal: { connected: paypal.connected, payerName: paypal.payerName, payerEmail: paypal.payerEmail, verified: paypal.verified, mandate: paypal.mandate ? { active: true, mode: paypal.mandate.mode, signedAt: paypal.mandate.signedAt } : null }, knows: agentBrief(u), autonomyLevels: AUTONOMY };
}

// ---------- missions in memory, persisted after every agent run ----------
function box(id, user) {
  let b = live.get(id);
  if (!b) {
    const s = getMission(id);
    if (!s) throw Object.assign(new Error('Unknown mission'), { status: 404 });
    s.feed ||= []; // the event feed is saved with the mission, so it survives a server restart
    // Missions from before the feed existed: rebuild the conversation from the saved messages.
    if (!s.feed.length) {
      const at = Date.parse(s.createdAt) || Date.now();
      for (const m of s.messages) {
        if (m.role === 'user') s.feed.push({ type: 'user', data: { text: String(m.content).split('\n[Photo')[0], image: String(m.content).includes('[Photo') }, at });
        else if (m.role === 'assistant' && m.content?.trim()) s.feed.push({ type: 'say', data: { text: m.content.trim() }, at });
      }
    }
    b = { s, clients: new Set(), busy: Promise.resolve(), log: s.feed };
    live.set(id, b);
  }
  if (user && b.s.userId !== user.id) throw Object.assign(new Error('Not your mission'), { status: 403 });
  if (user) b.s._user = user;
  return b;
}
// Streaming pieces are shown live but not kept: the history keeps only the finished reply.
const EPHEMERAL = new Set(['say_delta', 'say_reset']);
function emitter(b) {
  return (type, data) => {
    const evt = { type, data, at: Date.now() };
    if (!EPHEMERAL.has(type)) {
      b.log.push(evt);
      if (b.log.length > 400) b.log.shift();
    }
    for (const res of b.clients) res.write(`data: ${JSON.stringify(evt)}\n\n`);
    pushFor(b, evt);
  };
}

// ---------- notifications: only the moments that need the user, and only when they are not looking ----------
// In the mission owner's app language.
const langFor = (s) => langOf(s._user?.lang || getUser(s.userId)?.lang);
const EUR = (v, s, L) => money(L, v, s.envelope.currency || 'EUR');
function needsCount(u) {
  return u.missions.map(getMission).filter(Boolean).map((s) => missionSummary(live.get(s.id)?.s || s, { busy: !!live.get(s.id)?.running })).filter((m) => m.status === 'needs_you' && !m.archived).length;
}
async function pushTo(s, msg) {
  const u = getUser(s.userId);
  if (!u?.push?.length) return;
  const changed = await Push.notify(u, { ...msg, url: `/?mission=${s.id}`, badge: needsCount(u) });
  if (changed) saveUser(u);
}
function pushFor(b, { type, data }) {
  if (b.clients.size && type !== 'wrapup') return; // they are looking at this mission right now (the recap always goes to the phone)
  if (!['approval', 'request', 'collected', 'wrapup', 'share_paid'].includes(type)) return;
  const s = b.s;
  const title = s.title || 'Mandat';
  const L = langFor(s);
  if (type === 'approval' && data.status !== 'approved' && data.status !== 'declined') pushTo(s, { title, body: tr(L, 'Approve {amount} at {merchant}? Tap to review.', { amount: EUR(data.amount, s, L), merchant: data.merchant }), tag: 'ap-' + data.id });
  else if (type === 'request' && data.status === 'accepted') pushTo(s, { title, body: tr(L, data.slot ? '{merchant} accepted your booking for {slot}.' : '{merchant} accepted your booking.', { merchant: data.merchant, slot: data.slot }), tag: 'rq-' + data.id });
  else if (type === 'request' && data.status === 'declined') pushTo(s, { title, body: tr(L, "{merchant} can't take it. Mandat is looking for another option.", { merchant: data.merchant }), tag: 'rq-' + data.id });
  else if (type === 'request' && data.status === 'countered') pushTo(s, { title, body: tr(L, '{merchant} proposes {slot} instead. Does that work?', { merchant: data.merchant, slot: data.counterSlot }), tag: 'rq-' + data.id });
  else if (type === 'collected') pushTo(s, { title, body: tr(L, '{merchant} confirmed your booking. {amount} deposit paid with PayPal.', { merchant: data.merchant, amount: EUR(data.amount, s, L) }), tag: 'cf-' + s.id });
  else if (type === 'wrapup' && !b.s.closed) {
    b.s.closed = true;
    const first = data.lines?.find((l) => l.when);
    const [d, time] = first ? String(first.when).replace(/^\d{4}-/, '').split(' ') : [];
    const when = time ? tr(L, '{date} at {time}', { date: d, time }) : d;
    pushTo(s, { title: '✓ ' + data.headline, body: `${first ? `${first.what} · ${when}. ` : ''}${data.reminders?.length ? trn(L, data.reminders.length, '{n} reminder planned.', '{n} reminders planned.') + ' ' : ''}${tr(L, 'Tell me if you want to change anything.')}`, tag: 'done-' + s.id });
  }
  else if (type === 'share_paid') pushTo(s, { title, body: tr(L, '{friend} paid their share: {amount}.', { friend: data.friend, amount: EUR(data.amount, s, L) }), tag: 'sh-' + data.invoiceId });
}
// When everything is booked: make sure reminders exist and the "All set" recap is on screen and on the phone.
function closeLoop(b, emit) {
  if (b.s.closed || missionSummary(b.s).status !== 'done') return;
  const tz = getUser(b.s.userId)?.tz || 'UTC';
  for (const r of autoReminders(b.s, tz)) emit('reminder', r);
  b.s.wrapped = wrapCard(b.s);
  emit('wrapup', b.s.wrapped); // the recap card, and the phone notification (pushFor)
}

// After the agent's turn: a question for the user, or everything booked.
function pushAfterRun(b) {
  if (b.clients.size) return;
  const m = missionSummary(b.s);
  if (m.status === 'needs_you' && m.needs.startsWith('Answer') && b.s.lastAsked !== m.last) {
    b.s.lastAsked = m.last;
    pushTo(b.s, { title: b.s.title || 'Mandat', body: m.needs.replace(/^Answer: /, ''), tag: 'q-' + b.s.id });
  }
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
      closeLoop(b, emit);
      pushAfterRun(b);
      saveMission(b.s);
    }
  });
  return b.busy;
}
const api = (h) => async (req, res) => {
  try {
    res.json(await h(req, res));
  } catch (e) {
    res.status(e.status || 400).json({ error: tr(reqLang(req), e.message) }); // fixed messages are translated as they are
  }
};

app.get('/api/health', (req, res) => res.json({ ok: true, paypal: PayPal.MODE }));

app.get('/api/me', api(async (req, res) => {
  const u = me(req, res);
  const missions = u.missions.map((id) => getMission(id)).filter(Boolean).map((s) => missionSummary(live.get(s.id)?.s || s, { busy: !!live.get(s.id)?.running }));
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
  if (req.body?.onboarded === true) u.onboarded = true;
  saveUser(u);
  return { user: publicUser(u) };
}));

// Memory: the user sees everything Mandat remembers, can teach it something, and can delete any line.
app.post('/api/me/memory', api(async (req, res) => {
  const u = me(req, res);
  const text = String(req.body?.text || '').trim().replace(/\s+/g, ' ').slice(0, 220);
  if (text.length < 3) throw Object.assign(new Error('Write a short sentence.'), { status: 400 });
  if (/\b(?:\d[ -]?){13,19}\b|password|cvv|iban/i.test(text)) throw Object.assign(new Error('Payment details and passwords never go into memory.'), { status: 400 });
  u.memory ||= [];
  u.memory.push({ id: 'mem_' + crypto.randomBytes(4).toString('hex'), text, kind: KINDS.includes(req.body?.kind) ? req.body.kind : 'fact', at: new Date().toISOString(), from: 'you', fromTitle: 'You' });
  if (u.memory.length > 80) u.memory.shift();
  saveUser(u);
  return { user: publicUser(u) };
}));
app.delete('/api/me/memory/:id', api(async (req, res) => {
  const u = me(req, res);
  u.memory = (u.memory || []).filter((m) => m.id !== req.params.id);
  saveUser(u);
  return { user: publicUser(u) };
}));

// Forget everything the agent knows about me (profile and memory), keep PayPal connection and missions.
app.post('/api/me/forget', api(async (req, res) => {
  const u = me(req, res);
  u.profile = newUser().profile;
  u.memory = [];
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
    const { payerName, payerId, ...mandate } = m;
    u.paypal.mandate = { ...mandate, signedAt: new Date().toISOString() };
    // Approving the mandate is the PayPal sign-in: one trip to PayPal connects the account and signs.
    u.paypal.connected = true;
    if (m.payer) u.paypal.payerEmail = m.payer;
    if (payerName) u.paypal.payerName = payerName;
    if (!u.profile.name && payerName) u.profile.name = payerName;
    if (!u.profile.email && m.payer) u.profile.email = m.payer;
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

// ---------- activity: every money movement across missions (shown in an AG Grid ledger) ----------
const DEPOSIT_STATUS = { held: 'Held', captured: 'Paid', released: 'Released', refunded: 'Refunded' };
function activityRows(u) {
  const rows = [];
  for (const id of u.missions) {
    const m = getMission(id);
    if (!m) continue;
    const mission = { missionId: m.id, mission: m.title || 'Mission', emoji: m.emoji || '✦' };
    for (const e of m.envelope.entries) {
      const status = DEPOSIT_STATUS[e.state] || e.state;
      // Money that actually left: captured minus refunds; a hold is reserved, not spent.
      const amount = e.state === 'captured' || e.state === 'refunded' ? -(e.amount - (e.refunded || 0)) : e.state === 'held' ? -e.amount : 0;
      rows.push({ ...mission, id: e.id, at: e.at, kind: 'Deposit', who: e.merchant, what: e.label, status, amount, gross: e.amount, refunded: e.refunded || 0, ref: e.paypal?.captureId || e.paypal?.authorizationId || '', mode: e.paypal?.mode || '' });
    }
    for (const sh of m.shares || []) {
      if (!sh.invoiceId) continue;
      rows.push({ ...mission, id: sh.invoiceId, at: sh.at || m.createdAt, kind: 'Share', who: sh.friend, what: sh.label || '', status: sh.status === 'PAID' ? 'Paid back' : sh.error ? 'Failed' : 'Owed to you', amount: sh.status === 'PAID' ? sh.amount : 0, owed: sh.status === 'PAID' ? 0 : sh.amount, gross: sh.amount, ref: sh.invoiceId, payUrl: sh.payUrl, mode: sh.mode || '' });
    }
  }
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
app.get('/api/me/activity', api(async (req, res) => {
  const u = me(req, res);
  const rows = activityRows(u);
  const sum = (f) => Math.round(rows.reduce((t, r) => t + f(r), 0) * 100) / 100;
  return {
    rows,
    totals: {
      paid: sum((r) => (r.kind === 'Deposit' && (r.status === 'Paid' || r.status === 'Refunded') ? -r.amount : 0)),
      held: sum((r) => (r.kind === 'Deposit' && r.status === 'Held' ? r.gross : 0)),
      owed: sum((r) => r.owed || 0),
      back: sum((r) => (r.kind === 'Share' ? r.amount : 0) + (r.refunded || 0)),
    },
  };
}));
// "Refunds in October", "what Sam still owes"… → an AG Grid filter model, in one small call.
app.post('/api/me/activity/ask', api(async (req, res) => {
  const q = String(req.body?.q || '').trim().slice(0, 200);
  allowance(me(req, res));
  if (!q) throw new Error('Ask something');
  const today = new Date().toISOString().slice(0, 10);
  const { message } = await chat({
    model: MODELS.fast, fallback: MODELS.smart, json: true, temperature: 0, maxTokens: 2000,
    messages: [{ role: 'system', content: `Turn a request about a payments ledger into AG Grid filters. Today is ${today}. Columns: at (date), mission (text), who (merchant or friend name), what (text), kind ("Deposit" or "Share"), status ("Held","Paid","Released","Refunded","Owed to you","Paid back"), amount (number, negative = money out). Reply JSON only: {"filterModel":{<col>:<filter>}, "quickFilter": "<optional free text>", "summary":"<5-8 words describing the filter, in ${reqLang(req) === 'fr' ? 'French' : 'English'}>"}. Text filter: {"filterType":"text","type":"contains"|"equals","filter":"..."}. Number: {"filterType":"number","type":"greaterThan"|"lessThan"|"equals","filter":n}. Date: {"filterType":"date","type":"inRange","dateFrom":"YYYY-MM-DD","dateTo":"YYYY-MM-DD"}. Use only these columns.` }, { role: 'user', content: q }],
  });
  let out = {};
  try { out = JSON.parse(message.content || '{}'); } catch {}
  const allowed = new Set(['at', 'mission', 'who', 'what', 'kind', 'status', 'amount']);
  const filterModel = Object.fromEntries(Object.entries(out.filterModel || {}).filter(([k, v]) => allowed.has(k) && v && typeof v === 'object'));
  return { filterModel, quickFilter: String(out.quickFilter || '').slice(0, 60), summary: String(out.summary || q).slice(0, 80) };
}));

// ---------- missions ----------
app.post('/api/missions', api(async (req, res) => {
  const u = me(req, res);
  if (!u.paypal.mandate) throw new Error('Sign the PayPal mandate first.');
  if (u.frozen) throw new Error('Mandat is stopped. Resume it in Settings.');
  const { intent = '', budget, location = null } = req.body || {};
  const emoji = isEmoji(req.body?.emoji) ? req.body.emoji.trim() : emojiFor(intent);
  // The budget is optional: the pill wins, then the amount said in the message, then a suggestion;
  // with none of these, the mission stays under the user's daily limit.
  const used = monthCommitted(u, u.missions.map(getMission));
  const said = budgetFromText(intent);
  const source = req.body?.budgetSource === 'pill' && budget > 0 ? 'pill' : said ? 'words' : budget > 0 ? 'suggested' : 'limit';
  const total = source === 'pill' || source === 'suggested' ? Math.round(budget) : source === 'words' ? said.amount : Math.min(u.rules.dailyCap || 300, Math.max(0, u.rules.monthlyCap - used));
  const L = reqLang(req);
  if (source === 'limit' && total < 1) throw new Error(tr(L, 'Your monthly limit ({cap}) is already planned. Raise it in Settings, or say a budget.', { cap: money(L, u.rules.monthlyCap) }));
  if (!(total > 0 && total <= 5000)) throw new Error('A mission budget goes from 1 to 5,000 €.');
  if (used + total > u.rules.monthlyCap) throw new Error(tr(L, 'This would exceed your monthly limit ({cap}, {used} already planned).', { cap: money(L, u.rules.monthlyCap), used: money(L, used) }));
  allowance(u, 'missions');
  allowance(u, 'turns');
  const s = createSession({ budget: total, approveAbove: approveAboveFor(u), purpose: intent.slice(0, 120), location, language: req.get('X-Lang') || req.headers['accept-language']?.slice(0, 5) || 'en', userId: u.id, emoji });
  s.envelope.source = source;
  s.title = plainTitle(intent); // instant; the AI title replaces it in the background
  u.missions.unshift(s.id);
  saveUser(u);
  s.feed = [];
  saveMission(s);
  const b = { s, clients: new Set(), busy: Promise.resolve(), log: s.feed };
  live.set(s.id, b);
  b.s._user = u;
  const imgs = saveImages(u, req.body?.images || (req.body?.image ? [req.body.image] : []));
  emitter(b)('user', { text: intent, images: imgs.map((i) => i.url) });
  run(b, (emit) => userTurn(b.s, intent, emit, { images: imgs.map((i) => i.data) }));
  titleFor(intent).then(({ title, emoji: e }) => {
    if (title === b.s.title && e === b.s.emoji) return;
    b.s.title = title;
    b.s.emoji = e;
    saveMission(b.s);
    emitter(b)('title', { title, emoji: e });
  });
  return { id: s.id, summary: missionSummary(s) };
}));

// A short, clean mission title (e.g. "Two weeks in Spain"), written by the fast model; plain fallback.
function plainTitle(intent) {
  if (!intent.trim()) return 'Photo mission';
  return intent.replace(/\s+/g, ' ').trim().split(/[,.;:!?]/)[0].slice(0, 40).trim().replace(/[\s,;:.\-–]+$/, '') || 'New mission';
}
// Title and emoji in one cheap call: "Dinner for Léa's birthday" · 🎂
async function titleFor(intent) {
  const fallback = { title: plainTitle(intent), emoji: emojiFor(intent) };
  if (!intent.trim()) return fallback;
  try {
    const { message } = await chat({ model: MODELS.fast, fallback: MODELS.smart, maxTokens: 1500, temperature: 0.3, messages: [{ role: 'user', content: `For this errand: "${intent.slice(0, 300)}"\nReply with exactly one line: a single emoji that best shows what it is about (e.g. 🍽️ dinner, 💍 wedding, 🚆 train trip, 🎂 birthday, 🔧 repair), one space, then a 2-5 word title in the same language as the errand. No quotes, no final period.` }] });
    const line = (message.content || '').trim().split('\n')[0];
    const m = line.match(/^(\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*)\s*(.*)$/u);
    const title = (m ? m[2] : line).trim().replace(/^["'«]|["'»]$/g, '').slice(0, 42);
    return { title: title || fallback.title, emoji: m && isEmoji(m[1]) ? m[1] : fallback.emoji };
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
  const text = String(req.body?.text || '').trim().slice(0, 2000);
  const imgs = saveImages(u, req.body?.images || (req.body?.image ? [req.body.image] : []));
  if (!text && !imgs.length) throw new Error('Empty message');
  allowance(u);
  emitter(b)('user', { text, images: imgs.map((i) => i.url) });
  run(b, (emit) => userTurn(b.s, text, emit, { images: imgs.map((i) => i.data) }));
  return { queued: true };
}));

// Split-bill invoices: ask PayPal for fresh statuses; a newly paid share is announced in the mission.
app.get('/api/missions/:id/shares', api(async (req, res) => {
  const b = box(req.params.id, me(req, res));
  let changed = false;
  await Promise.all(b.s.shares.filter((sh) => sh.invoiceId && !sh.error && sh.status !== 'PAID').map(async (sh) => {
    const status = await invoiceStatus(sh.invoiceId).catch(() => null);
    if (!status || status === sh.status) return;
    sh.status = status;
    changed = true;
    if (status === 'PAID') emitter(b)('share_paid', { invoiceId: sh.invoiceId, friend: sh.friend, amount: sh.amount });
  }));
  if (changed) saveMission(b.s);
  return { shares: b.s.shares.filter((sh) => sh.invoiceId).map(({ qr, ...sh }) => sh) };
}));

// ---------- images people send: stored as files, visible only to their owner ----------
const MEDIA = path.resolve(process.env.MANDAT_DATA || 'data', 'media');
function saveImages(u, list) {
  const out = [];
  for (const d of (Array.isArray(list) ? list : []).slice(0, 4)) {
    const m = typeof d === 'string' && d.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) continue;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2.5e6) throw new Error('An image is too large (2.5 MB max).');
    const name = crypto.randomBytes(9).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    fs.mkdirSync(path.join(MEDIA, u.id), { recursive: true });
    fs.writeFileSync(path.join(MEDIA, u.id, name), buf);
    out.push({ url: `/api/media/${u.id}/${name}`, data: d });
  }
  return out;
}
app.get('/api/media/:uid/:file', (req, res) => {
  const u = me(req, res);
  if (u.id !== req.params.uid || !/^[0-9a-f]{18}\.(jpg|png|webp)$/.test(req.params.file)) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path.join(MEDIA, u.id, req.params.file), (e) => e && res.status(404).end());
});

// Devices that receive notifications (one per browser / installed app).
app.get('/api/health', (req, res) => res.json({ ok: true, paypal: PayPal.MODE }));
app.get('/api/push/key', (req, res) => res.json({ key: Push.publicKey() }));
app.post('/api/me/push', api(async (req, res) => {
  const u = me(req, res);
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Invalid subscription');
  u.push = (u.push || []).filter((x) => x.endpoint !== sub.endpoint).concat({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, at: new Date().toISOString() }).slice(-5);
  saveUser(u);
  return { devices: u.push.length };
}));
app.post('/api/me/push/off', api(async (req, res) => {
  const u = me(req, res);
  u.push = (u.push || []).filter((x) => x.endpoint !== req.body?.endpoint);
  saveUser(u);
  return { devices: u.push.length };
}));
app.post('/api/me/push/test', api(async (req, res) => {
  const u = me(req, res);
  const changed = await Push.notify(u, { title: 'Mandat', body: tr(u.lang, 'Notifications are on. I will only ping you when something needs you.'), url: '/', tag: 'test', badge: needsCount(u) });
  if (changed) saveUser(u);
  return { devices: (u.push || []).length };
}));

// ---------- calendar files and reminders ----------
function sendIcs(res, name, events, tz) {
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${name.replace(/[^\w .-]+/g, '').trim() || 'mandat'}.ics"`);
  res.send(ics(name, events, tz));
}
app.get('/api/missions/:id/calendar.ics', (req, res) => {
  try {
    const u = me(req, res);
    const b = box(req.params.id, u);
    const ev = planEvents(b.s);
    if (!ev.length) return res.status(404).send(tr(u.lang, 'Nothing with a date in this plan yet.'));
    sendIcs(res, b.s.title || tr(u.lang, 'Mandat plan'), ev, u.tz || 'UTC');
  } catch (e) { res.status(e.status || 400).send(e.message); }
});
app.get('/api/missions/:id/reminders/:rid.ics', (req, res) => {
  try {
    const u = me(req, res);
    const b = box(req.params.id, u);
    const r = (b.s.reminders || []).find((x) => x.id === req.params.rid);
    if (!r) return res.status(404).send(tr(u.lang, 'Unknown reminder'));
    // The calendar event is the event itself when known, with an alert at the reminder time.
    const start = r.eventAt || r.local;
    const before = Math.max(0, Math.round((localToUtc(start, u.tz || 'UTC') - new Date(r.at)) / 60000));
    sendIcs(res, r.text.slice(0, 60), [{ uid: r.id, summary: r.text, start, minutes: 60, location: r.place, description: tr(u.lang, '{title} · reminder from Mandat', { title: b.s.title || 'Mandat' }), alarms: [before] }], u.tz || 'UTC');
  } catch (e) { res.status(e.status || 400).send(e.message); }
});
// Due reminders become phone notifications (and a line in the mission), checked every 30 seconds.
setInterval(() => {
  try {
    const now = Date.now();
    for (const s0 of missionsOnDisk()) {
      if (!s0.reminders?.some((r) => !r.sent && Date.parse(r.at) <= now)) continue;
      const b = box(s0.id);
      for (const r of b.s.reminders.filter((x) => !x.sent && Date.parse(x.at) <= now)) {
        r.sent = true;
        emitter(b)('reminder_due', { id: r.id, text: r.text });
        pushTo(b.s, { title: '⏰ ' + (b.s.title || 'Mandat'), body: r.text, tag: 'rm-' + r.id }); // the reminder's own words
      }
      saveMission(b.s);
    }
  } catch (e) { console.warn('[reminders]', e.message); }
}, 30000);

// Archive keeps the history; delete only when no money is held for the mission.
app.post('/api/missions/:id/archive', api(async (req, res) => {
  const b = box(req.params.id, me(req, res));
  b.s.archived = req.body?.archived !== false;
  saveMission(b.s);
  return { summary: missionSummary(b.s) };
}));
app.delete('/api/missions/:id', api(async (req, res) => {
  const u = me(req, res);
  const b = box(req.params.id, u);
  if (b.s.envelope.entries.some((e) => e.state === 'held')) throw Object.assign(new Error('Money is still held for this mission. Release it or archive the mission instead.'), { status: 409 });
  for (const c of b.clients) c.end();
  live.delete(b.s.id);
  u.missions = u.missions.filter((id) => id !== b.s.id);
  saveUser(u);
  deleteMission(b.s.id);
  return { ok: true };
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
  const u = me(req, res);
  const b = box(req.params.id, u);
  allowance(u);
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
// Requests live in missions on disk; scan them all so nothing is lost after a restart.
function missionsOnDisk() {
  const dir = path.resolve(process.env.MANDAT_DATA || 'data', 'missions');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => live.get(f.slice(0, -5))?.s || getMission(f.slice(0, -5))).filter(Boolean);
}
app.get('/merchant/:mid', (req, res) => res.sendFile(path.resolve('public/merchant.html')));
app.get('/api/merchants/:mid/requests', api(async (req) => {
  const m = merchant(req.params.mid);
  checkInbox(m.id, req.query.k);
  const out = [];
  for (const s of missionsOnDisk()) for (const r of Object.values(s.requests || {})) {
    if (r.merchant_id !== m.id) continue;
    const { sessionId, inbox, ...pub } = r;
    const pay = r.paymentId ? s.envelope.entries.find((e) => e.id === r.paymentId) : null;
    out.push({ ...pub, customer: r.customer ? String(r.customer).split(' ')[0] : 'A Mandat customer', deposit_state: pay?.state || null, deposit_held: pay?.amount || 0 });
  }
  return { merchant: { id: m.id, name: m.name, category: m.category, city: m.city, deposit: m.deposit }, requests: out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}));
app.post('/api/merchants/:mid/requests/:rid', api(async (req) => {
  const m = merchant(req.params.mid);
  checkInbox(m.id, req.body?.k);
  const action = ['accept', 'decline', 'counter'].includes(req.body?.action) ? req.body.action : null;
  if (!action) throw new Error('Choose accept, decline or counter');
  if (action === 'counter' && !String(req.body?.slot || '').trim()) throw new Error('Say which time you can do');
  const s = missionsOnDisk().find((x) => x.requests?.[req.params.rid]?.merchant_id === m.id);
  if (!s) throw Object.assign(new Error('Unknown request'), { status: 404 });
  if (s.requests[req.params.rid].status !== 'pending') throw Object.assign(new Error('This request was already answered.'), { status: 409 });
  const b = box(s.id);
  if (b.s.userId) b.s._user = getUser(b.s.userId);
  run(b, (emit) => resolveRequest(b.s, req.params.rid, { action, slot: req.body.slot, message: req.body.message }, emit));
  return { ok: true, status: action === 'accept' ? 'accepted' : action === 'counter' ? 'countered' : 'declined' };
}));

// The merchant confirms the booking: the held deposit is captured and paid to them.
app.post('/api/merchants/:mid/requests/:rid/collect', api(async (req) => {
  const m = merchant(req.params.mid);
  checkInbox(m.id, req.body?.k);
  const s = missionsOnDisk().find((x) => x.requests?.[req.params.rid]?.merchant_id === m.id);
  const r = s?.requests[req.params.rid];
  if (!r) throw Object.assign(new Error('Unknown request'), { status: 404 });
  const b = box(s.id);
  if (b.s.userId) b.s._user = getUser(b.s.userId);
  const entry = b.s.envelope.entries.find((e) => e.id === r.paymentId);
  if (!entry || entry.state !== 'held') throw Object.assign(new Error('No deposit is waiting to be collected.'), { status: 409 });
  // Collect now (the merchant sees it at once), then let the customer's agent tell them.
  const emit = emitter(b);
  await captureEntry(b.s, entry.id, emit, "Confirmed from their inbox");
  b.s.requests[r.id].status = 'confirmed';
  emit('request', b.s.requests[r.id]);
  emit('envelope', envelopeView(b.s));
  saveMission(b.s);
  pushFor(b, { type: 'collected', data: { merchant: m.name, amount: entry.amount } });
  run(b, (e2) => userTurn(b.s, `[system] ${m.name} confirmed the booking and collected the ${entry.amount} deposit (paid with PayPal). Mark it confirmed in the plan. The card already shows the payment, so do not repeat it: say nothing unless this was the last open booking (then set the reminders and wrap up) or there is something new the user must know.`, e2));
  return { ok: true, collected: entry.amount };
}));

// Friends pay their invoices while the app is closed: check open invoices every 2 minutes (PayPal API, free).
async function watchInvoices() {
  for (const f of fs.readdirSync(path.resolve(process.env.MANDAT_DATA || 'data', 'missions'))) {
    const s0 = getMission(f.replace(/\.json$/, ''));
    if (!s0?.shares?.some((sh) => sh.invoiceId && !sh.error && sh.mode !== 'offline' && sh.status !== 'PAID' && Date.now() - Date.parse(sh.at || s0.createdAt) < 30 * 864e5)) continue;
    const b = box(s0.id);
    for (const sh of b.s.shares.filter((x) => x.invoiceId && !x.error && x.mode !== 'offline' && x.status !== 'PAID')) {
      const status = await invoiceStatus(sh.invoiceId).catch(() => null);
      if (!status || status === sh.status) continue;
      sh.status = status;
      if (status === 'PAID') emitter(b)('share_paid', { invoiceId: sh.invoiceId, friend: sh.friend, amount: sh.amount });
      saveMission(b.s);
    }
  }
}
setInterval(() => watchInvoices().catch((e) => console.warn('[invoices]', e.message)), 120000);

app.listen(PORT, () => {
  console.log(`Mandat on ${BASE()} (PayPal: ${PayPal.MODE})`);
  probe(); // know right away whether the fast model answers
});
