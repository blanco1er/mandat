// Mandat server: account (PayPal login, profile, rules, mandate), missions (each with its own envelope),
// live event stream per mission (SSE), approvals, stop switch, merchant inbox.
import express from 'express';
import { shopEnabled } from './lib/shop.mjs';
import { insightsData, studioTurn, booksOf } from './lib/studio.mjs';
import { findPayment, receiptHtml } from './lib/receipt.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { setLiveLookup, createSession, userTurn, resolveApproval, resolveRequest, captureEntry, envelopeView, missionSummary, wrapCard, autoReminders, settleApprovals } from './lib/agent.mjs';
import * as PayPal from './lib/paypal.mjs';
import { geocode, searchAddress, reverseAddress } from './lib/places.mjs';
import { chat, MODELS, probe } from './lib/deepseek.mjs';
import { invoiceStatus } from './lib/invoices.mjs';
import { ics, planEvents, validTz, localToUtc, agendaOf } from './lib/calendar.mjs';
import { KINDS, remember, forget, memoryBrief, missionsBrief } from './lib/memory.mjs';
import { persist } from './lib/store.mjs';
import { synthesize, ttsEnabled } from './lib/tts.mjs';
import { transcribe, sttEnabled } from './lib/stt.mjs';
import { emojiFor, isEmoji } from './lib/emoji.mjs';
import { budgetFromText, currencyFromText } from './lib/budget.mjs';
import * as Push from './lib/push.mjs';
import { tr, trn, langOf, money } from './lib/i18n-server.mjs';
import { merchant, inboxAccess, inboxUrl, placeOf } from './lib/merchants.mjs';
import { newUser, getUser, userWithSetup, saveUser, getMission, saveMission, deleteMission, approveAboveFor, agentBrief, monthCommitted, AUTONOMY } from './lib/users.mjs';

const app = express();
const PORT = Number(process.env.PORT || 8790);
const BASE = () => process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`; // Render provides RENDER_EXTERNAL_URL
const live = new Map(); // missionId -> { s, clients:Set, busy:Promise, log:[] }

app.set('trust proxy', 1); // behind Render / a tunnel: the client IP is in X-Forwarded-For
app.use(express.json({ limit: '12mb' })); // photos arrive as data URLs, resized to 2048 px by the app (4 at most, 2.5 MB each)

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
  // the voice (one request per sentence) and the transcription have their own daily caps: never counted here
  if (req.method === 'GET' || req.path === '/tts' || req.path === '/stt') return next();
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const b = bursts.get(ip)?.filter((t) => now - t < 60000) || [];
  if (b.length >= Number(process.env.MANDAT_WRITES_PER_MINUTE || 90)) return res.status(429).json({ error: tr(reqLang(req), 'Too many requests at once. Wait a few seconds and try again.') });
  b.push(now);
  bursts.set(ip, b);
  if (bursts.size > 5000) bursts.clear();
  next();
});
// Daily AI allowance: per person and for the whole app (each agent turn or ledger question counts once).
const LIMITS = { turns: Number(process.env.MANDAT_TURNS_PER_USER_DAY || 150), missions: Number(process.env.MANDAT_MISSIONS_PER_USER_DAY || 30), studio: Number(process.env.MANDAT_STUDIO_TURNS_PER_USER_DAY || 200), studioGlobal: Number(process.env.MANDAT_STUDIO_TURNS_PER_DAY || 1500), global: Number(process.env.MANDAT_TURNS_PER_DAY || 3000) };
let usage = { day: '', global: 0, users: new Map() };
function allowance(u, kind = 'turns') {
  const day = new Date().toISOString().slice(0, 10);
  if (usage.day !== day) usage = { day, global: 0, studio: 0, users: new Map() };
  const mine = usage.users.get(u.id) || { turns: 0, missions: 0, studio: 0 };
  if (usage.global >= LIMITS.global) throw Object.assign(new Error(tr(u.lang, 'Mandat has reached its daily demo limit. Please come back tomorrow.')), { status: 429 });
  if (mine[kind] >= LIMITS[kind]) throw Object.assign(new Error(kind === 'missions' ? tr(u.lang, "That's {n} new missions today, the demo limit. Continue an existing one, or come back tomorrow.", { n: LIMITS.missions }) : tr(u.lang, "You reached today's demo limit for the AI. It resets at midnight (UTC).")), { status: 429 });
  mine[kind]++;
  if (kind === 'turns') usage.global++;
  usage.users.set(u.id, mine);
}
// The app's own files are always checked with the server before a stored copy is used: an app installed on
// the home screen must never keep running last week's code.
app.use(express.static(path.resolve('public'), { extensions: ['html'], setHeaders: (res, file) => { if (/\.(html|js|css|json)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); } }));
// The budget reader is shared with the app, so both understand "40 € each for 4" the same way.
app.get('/budget.mjs', (req, res) => res.type('text/javascript').sendFile(path.resolve('lib/budget.mjs')));

// ---------- account (cookie) ----------
function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
// New accounts per address and hour are limited: a robot cannot fill the disk.
const created = new Map();
function me(req, res) {
  let u = getUser(cookie(req, 'mandat_uid'));
  if (!u) {
    const hour = new Date().toISOString().slice(0, 13), key = req.ip + '|' + hour;
    if ((created.get(key) || 0) >= 40) throw Object.assign(new Error('Too many new visitors from this network. Please try again later.'), { status: 429 });
    created.set(key, (created.get(key) || 0) + 1);
    if (created.size > 5000) created.clear();
    u = newUser();
    saveUser(u);
    res.setHeader('Set-Cookie', `mandat_uid=${u.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  }
  return u;
}
function publicUser(u) {
  const { paypal, push, forgotten, ...rest } = u;
  return { ...rest, canRestore: !!(forgotten && Date.now() - forgotten.at < 7 * 864e5), notifications: (push || []).length, paypal: { connected: paypal.connected, payerName: paypal.payerName, payerEmail: paypal.payerEmail, verified: paypal.verified, mandate: paypal.mandate ? { active: true, mode: paypal.mandate.mode, signedAt: paypal.mandate.signedAt } : null }, knows: agentBrief(u), autonomyLevels: AUTONOMY };
}

// ---------- missions in memory, persisted after every agent run ----------
setLiveLookup((id) => live.get(id)?.s);
// Missions nobody watches and nothing runs leave memory after half an hour (they are on disk and in R2).
setInterval(() => {
  const now = Date.now();
  for (const [id, b] of live) if (!b.running && !b.clients.size && now - (b.used || 0) > 30 * 60000) live.delete(id);
}, 10 * 60000).unref();
function box(id, user) {
  let b = live.get(id);
  if (b) b.used = Date.now();
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
    // A feed that lost its beginning (it used to be cut at 400 events): the start of the conversation is
    // rebuilt from the saved messages, which are never cut.
    const firstUser = s.feed.find((e) => e.type === 'user' && e.data?.text);
    if (firstUser) {
      const head = (m) => String(m.content).split('\n[Photo')[0].trim();
      const idx = s.messages.findIndex((m) => m.role === 'user' && head(m) === String(firstUser.data.text).trim());
      if (idx > 0) {
        const at = Math.min(Date.parse(s.createdAt) || Infinity, (s.feed[0]?.at || Date.now()) - 1);
        const lost = [];
        for (const m of s.messages.slice(0, idx)) {
          if (m.role === 'user' && !String(m.content).startsWith('[system]')) lost.push({ type: 'user', data: { text: head(m), image: String(m.content).includes('[Photo') }, at });
          else if (m.role === 'assistant' && m.content?.trim()) lost.push({ type: 'say', data: { text: m.content.trim() }, at });
        }
        s.feed.unshift(...lost);
      }
    }
    for (const r of Object.values(s.requests || {})) r.inbox = inboxUrl(r.merchant_id, r.id); // private link per request
    for (const e of s.feed) if (e.type === 'request' && e.data?.id && e.data.merchant_id) e.data.inbox = inboxUrl(e.data.merchant_id, e.data.id);
    b = { s, clients: new Set(), busy: Promise.resolve(), log: s.feed };
    live.set(id, b);
    // approvals that no longer stand (already paid, replaced, dropped from the plan) are closed on load
    if (settleApprovals(s, (type, data) => s.feed.push({ type, data, at: Date.now() })).length) saveMission(s);
  }
  if (user && b.s.userId !== user.id) throw Object.assign(new Error('Not your mission'), { status: 403 });
  if (user) b.s._user = user;
  return b;
}
// Streaming pieces are shown live but not kept: the history keeps only the finished reply.
const EPHEMERAL = new Set(['say_delta', 'say_reset']);
const KEEP_IN_FEED = new Set(['user', 'say', 'payment', 'approval', 'approval_resolved', 'request', 'wrapup', 'shares', 'share_paid']);
function emitter(b) {
  return (type, data) => {
    const evt = { type, data, at: Date.now() };
    if (!EPHEMERAL.has(type)) {
      b.log.push(evt);
      // Room is made with the small technical events first: the conversation and the payments always stay.
      if (b.log.length > 1500) {
        const i = b.log.findIndex((e) => !KEEP_IN_FEED.has(e.type));
        b.log.splice(i >= 0 ? i : 0, 1);
      }
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
  try {
    const u = getUser(s.userId);
    if (!u?.push?.length) return;
    const changed = await Push.notify(u, { ...msg, url: `/?mission=${s.id}`, badge: needsCount(u) });
    if (changed) {
      const fresh = getUser(u.id); // only the subscriptions change; anything saved meanwhile is kept
      fresh.push = u.push;
      saveUser(fresh);
    }
  } catch (e) {
    console.warn('[push]', e.message);
  }
}
function pushFor(b, { type, data }) {
  if (b.clients.size && type !== 'wrapup') return; // they are looking at this mission right now (the recap always goes to the phone)
  if (!['approval', 'request', 'collected', 'wrapup', 'share_paid', 'notify'].includes(type)) return;
  const s = b.s;
  const title = s.title || 'Mandat';
  const L = langFor(s);
  if (type === 'approval' && data.status !== 'approved' && data.status !== 'declined') pushTo(s, { title, body: tr(L, 'Approve {amount} at {merchant}? Tap to review.', { amount: EUR(data.amount, s, L), merchant: data.merchant }), tag: 'ap-' + data.id });
  else if (type === 'request' && data.moved) pushTo(s, { title, body: data.moved === 'yes' ? tr(L, '{merchant} moved your booking to {slot}.', { merchant: data.merchant, slot: data.slot }) : tr(L, "{merchant} can't move it. Your booking stays as it was.", { merchant: data.merchant }), tag: 'rq-' + data.id });
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
  else if (type === 'notify') pushTo(s, { title, body: data.text, tag: 'nt-' + s.id + '-' + Date.now() });
  else if (type === 'share_paid') pushTo(s, { title, body: tr(L, '{friend} paid their share: {amount}.', { friend: data.friend, amount: EUR(data.amount, s, L) }), tag: 'sh-' + data.invoiceId });
}
// When everything is booked: make sure reminders exist and the "All set" recap is on screen and on the phone.
function closeLoop(b, emit) {
  if (b.s.closed || missionSummary(b.s).status !== 'done' || b.s.review?.missing?.length) return; // never 'all set' with an essential missing
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
      try {
        emit('busy', { on: false });
        if (!b.deleted) {
          emit('envelope', envelopeView(b.s));
          emit('summary', missionSummary(b.s));
          closeLoop(b, emit);
          pushAfterRun(b);
          saveMission(b.s);
        }
      } catch (e) {
        console.error('[after turn]', e);
      }
    }
  }).catch((e) => console.error('[turn]', e)); // the queue keeps going whatever happens
  return b.busy;
}
const api = (h) => async (req, res) => {
  try {
    res.json(await h(req, res));
  } catch (e) {
    res.status(e.status || 400).json({ error: tr(reqLang(req), e.message), ...(e.code ? { code: e.code } : {}) }); // fixed messages are translated as they are
  }
};

// The build the server runs: the app compares it with its own and reloads when a newer one is live.
const BUILD = (process.env.RENDER_GIT_COMMIT || '').slice(0, 12) || String(Date.now());
app.get('/api/health', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ok: true, paypal: PayPal.MODE, build: BUILD, shop: shopEnabled() }); }); // shop: whether product search is on (never the key)

app.get('/api/me', api(async (req, res) => {
  const u = me(req, res);
  const missions = u.missions.map((id) => getMission(id)).filter(Boolean).map((s) => { const m = live.get(s.id)?.s || s; if (settleApprovals(m, (type, data) => (m.feed ||= []).push({ type, data, at: Date.now() })).length) saveMission(m); return missionSummary(m, { busy: !!live.get(s.id)?.running }); });
  // AG Studio's licence key is a client-side key by design (it only removes the watermark), so it is sent as is.
  return { user: publicUser(u), missions, paypalMode: PayPal.MODE, agStudioKey: process.env.AG_STUDIO_LICENSE_KEY || '', hasPrevious: !!getUser(cookie(req, 'mandat_prev')) };
}));

const cleanFit = (f) => Object.fromEntries(['cut', 'top', 'bottom', 'shoes', 'height', 'style', 'age'].map((k) => [k, String(f[k] ?? '').trim().slice(0, 80)]).filter(([, v]) => v));
app.post('/api/me', api(async (req, res) => {
  const u = me(req, res);
  const { profile, rules, voice } = req.body || {};
  if (profile) {
    const p = u.profile;
    for (const k of ['name', 'email', 'phone', 'diet', 'preferences']) if (typeof profile[k] === 'string') p[k] = profile[k].slice(0, 300);
    if (profile.home === null) p.home = null;
    else if (profile.home && typeof profile.home.label === 'string') {
      const h = profile.home;
      p.home = { label: h.label.slice(0, 200), ...(Number.isFinite(h.lat) && Number.isFinite(h.lon) ? { lat: h.lat, lon: h.lon } : {}) };
    }
    // Sizes and style, so Mandat can buy clothes and shoes that fit.
    if (profile.fit && typeof profile.fit === 'object') p.fit = cleanFit(profile.fit);
    // Your people: who they are to you, their sizes and style, and the email their PayPal requests go to
    // (older entries kept a free "contact"). The email is optional: people are not only for split bills.
    if (Array.isArray(profile.people)) {
      p.people = profile.people.slice(0, 30).map((x) => {
        const c = String(x.email || x.contact || '').trim().slice(0, 120);
        return {
          name: String(x.name || '').trim().slice(0, 60),
          email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c) ? c : '',
          relation: String(x.relation || '').trim().slice(0, 30),
          ...(x.fit && typeof x.fit === 'object' ? { fit: cleanFit(x.fit) } : {}),
        };
      }).filter((x) => x.name);
    }
  }
  if (rules) {
    if (AUTONOMY[rules.autonomy]) u.rules.autonomy = rules.autonomy;
    for (const k of ['approveAbove', 'monthlyCap', 'dailyCap']) if (Number.isFinite(rules[k]) && rules[k] >= 0 && rules[k] <= 1000000) u.rules[k] = rules[k];
  }
  if (voice && typeof voice.on === 'boolean') u.voice.on = voice.on;
  if (req.body?.onboarded === true) u.onboarded = true;
  saveUser(u);
  return { user: publicUser(u) };
}));

// Profile photo (square, small), or none.
app.post('/api/me/avatar', api(async (req, res) => {
  const u = me(req, res);
  if (req.body?.image === null) u.avatar = null;
  else {
    const [img] = saveImages(u, [req.body?.image]);
    if (!img) throw new Error('Choose a photo.');
    u.avatar = img.url;
  }
  saveUser(u);
  return { user: publicUser(u) };
}));

// What Mandat knows, as a profile the person reads: grouped by person and theme, short, in their language.
// Organised once by the fast model and cached until the memory changes (forgetting one line updates the cache).
const memHash = (mem, L) => crypto.createHash('sha1').update('k3' + L + JSON.stringify((mem || []).map((m) => [m.id, m.text]))).digest('hex');
app.get('/api/me/knowledge', api(async (req, res) => {
  const u = me(req, res);
  const L = reqLang(req);
  const mem = u.memory || [];
  if (!mem.length) return { count: 0, people: [], groups: [] };
  const hash = memHash(mem, L);
  if (u.knowledge?.hash === hash) return { ...u.knowledge.data, count: mem.length };
  const notes = mem.map((m, i) => `[${i + 1}] ${m.text}`).join('\n'); // short numbers: the model copies them reliably
  const fr = L === 'fr';
  const sys = `You organise the memory of Mandat, a personal assistant app, into the page its user reads under "What Mandat knows about you". "The user" in the notes is the reader. Write in ${fr ? 'French, addressing the reader as "vous"' : 'English, addressing the reader as "you"'}. Do not deliberate: map each note directly.
Rules: each other person (partner, child, friend) gets one card: name, relation to the reader (${fr ? '"Votre partenaire"' : '"Your partner"'}), and details as short phrases of at most 6 words (${fr ? '"Née le 21 octobre 2002", "Halal, sans porc", "E-mail : x"' : '"Born 21 October 2002", "Halal, no pork", "Email: x"'}). Everything about the reader goes into groups with short titles (${fr ? '"Vos goûts", "Vos habitudes", "Vos lieux", "Vos règles", "À savoir"' : '"Your tastes", "Your habits", "Your places", "Your rules", "Good to know"'}), items as short phrases. Merge duplicates, drop empty statements (e.g. "avoids nothing in particular"). Each item lists the numbers of its notes in "ids" (e.g. [2, 5]). "summary": one short friendly line about the reader.
JSON only: {"summary":"","people":[{"name":"","relation":"","details":[{"text":"","ids":[]}]}],"groups":[{"title":"","items":[{"text":"","ids":[]}]}]}`;
  let data = null;
  try {
    const { message } = await chat({ model: MODELS.fast, fallback: MODELS.smart, json: true, temperature: 0.2, maxTokens: 6000, messages: [{ role: 'system', content: sys }, { role: 'user', content: notes }] });
    data = JSON.parse(message.content || '{}');
  } catch {}
  const idOf = (x) => mem[parseInt(String(x).replace(/\D/g, ''), 10) - 1]?.id;
  const clean = (it) => ({ text: String(it?.text || '').slice(0, 90), ids: [...new Set((Array.isArray(it?.ids) ? it.ids : []).map(idOf).filter(Boolean))] });
  data = data && (Array.isArray(data.people) || Array.isArray(data.groups)) ? {
    summary: String(data.summary || '').slice(0, 140),
    people: (data.people || []).slice(0, 20).map((p) => ({ name: String(p?.name || '').slice(0, 40), relation: String(p?.relation || '').slice(0, 40), details: (p?.details || []).slice(0, 12).map(clean).filter((d) => d.text) })).filter((p) => p.name),
    groups: (data.groups || []).slice(0, 8).map((g) => ({ title: String(g?.title || '').slice(0, 40), items: (g?.items || []).slice(0, 20).map(clean).filter((d) => d.text) })).filter((g) => g.items.length),
  } : null;
  if (!data) return { count: mem.length, summary: '', people: [], groups: [{ title: '', items: mem.map((m) => ({ text: m.text, ids: [m.id] })) }] };
  const fresh = getUser(u.id);
  fresh.knowledge = { hash, lang: L, data };
  saveUser(fresh);
  return { ...data, count: mem.length };
}));

// Getting to know you: one short question at a time; every lasting answer goes into memory.
app.post('/api/me/interview', api(async (req, res) => {
  const u = me(req, res);
  const L = reqLang(req);
  // The opening is fixed: instant and free. Someone Mandat already knows is asked what has changed.
  if (!(Array.isArray(req.body?.history) && req.body.history.length)) {
    if (u.memory?.length || u.profile.people?.length) return {
      say: tr(L, 'Good to see you again. What shall we talk about? Anything goes.'),
      choices: ['My people', 'My sizes and style', 'A plan coming up', 'A change in my life'].map((c) => tr(L, c)),
      saved: [], done: false, user: publicUser(u),
    };
    return {
      say: tr(L, 'Who do you most often plan outings or trips with?'),
      choices: ['My partner', 'My children', 'My family', 'Friends', 'Colleagues', 'Mostly on my own'].map((c) => tr(L, c)),
      saved: [], done: false, user: publicUser(u),
    };
  }
  allowance(u);
  const hist = (Array.isArray(req.body?.history) ? req.body.history : []).slice(-16)
    .map((m) => ({ role: m.role === 'you' ? 'user' : 'assistant', content: String(m.text || '').slice(0, 500) }));
  const known = [agentBrief(u), memoryBrief(u)].filter(Boolean).join('\n') || 'Nothing yet.';
  const asked = hist.filter((m) => m.role === 'assistant').length;
  const sys = `You are Mandat, a personal agent that books, buys and pays errands (restaurants, trips, events, gifts, clothes, furniture, repairs, bills shared with friends). You are getting to know the user in a warm, free conversation: they can talk about anything (people, tastes, places, habits, plans, changes in their life) and you keep it going with one good question at a time, so future missions need fewer questions. Write in ${L === 'fr' ? 'French, using "vous"' : 'English'}.
What you already know (never ask it again):
${known}
What their missions show (use it to propose smart answers and good questions, e.g. a place they booked twice, people they split bills with):
${missionsBrief(u) || 'No mission yet.'}
Follow the user's lead first: whatever they bring up (a sport, a trip, a pet, a new job, a worry), react to it in a few natural words, save what lasts, and ask a follow-up about THAT before moving to anything else. When they pick a topic, ask about that topic. Rules: ask ONE short, concrete question at a time (20 words at most) about what helps with errands: the people they often plan with (name, relation, email for PayPal requests), their diets and allergies, favourite or avoided places and cuisines, usual budgets, how they like to travel, timing habits, important dates (birthdays, anniversaries), accessibility needs, and for shopping whether they wear menswear or womenswear, their sizes and style (top size, trouser size, shoe size, height, style such as classic, casual, elegant, sporty, streetwear) and those of the people they buy for (a child: age and clothing size; a partner: sizes and style). For sizes, offer the usual sizes as choices ("S", "M", "L", "XL", or "38" to "44" for shoes). Go deeper before moving on: when the user mentions a person (partner, child, friend, parent), ask their first name next, then one or two useful details about them, one question at a time (birthday or age, diet or allergies, what they love, email for PayPal requests), then change topic. Save people completely, with name and relation (e.g. "Léa is the user's daughter, born on 12 March 2015"); keep a birth date rather than an age when you can. Always give 2 to 4 short ready answers in "choices" (3 words or fewer each), even for names, dates or emails: offer what makes sense there (names you already know, "Not sure", "I'll add it later"...). For people, think partner, children, family, friends, colleagues. Every choice must be a real possible answer to your question (never filler like "I note it"); for a name, offer names you already know or "Later". Always speak to the user, never to the people they mention. The user can tick several answers at once and add their own words (they arrive comma-separated): take them all into account, and when several people come up, go through them one at a time. The user can always type their own answer or skip.
Life changes: if an answer contradicts what you know (a breakup, a move, a new job, someone no longer around), put the outdated memory ids in "forget" and save the new facts, and say it in a few kind words. When the user says nothing has changed, thank them and offer to add more or stop.
When you close (done=true), always end with one sentence inviting them to come back here if their life changes (a move, new people around them, new habits). From the user's last answer, put each lasting fact in "save" as one self-contained sentence. Questions asked so far: ${asked}. After about 6 questions, or if the user wants to stop, ask if there is anything else Mandat should know; when they say no, thank them in one warm sentence and set "done" to true. Never ask for payment details, passwords or ID numbers. No dashes as punctuation.
When the user names a person close to them, also put them in "people" (name, relation in one word such as partner, child, parent, sibling, friend, colleague, and email, sizes or style when given) so Mandat can buy for them and send them PayPal requests. The user's own sizes and style go in "me" (top, bottom = trouser size, shoes = EU size, height in cm, style).
Reply with JSON only: {"save":[{"fact":"...","kind":"preference|person|place|habit|constraint|fact"}],"forget":["mem_..."],"people":[{"name":"...","relation":"...","email":"","fit":{"cut":"","age":"","top":"","bottom":"","shoes":"","style":""}}],"me":{"cut":"Menswear|Womenswear|Both","top":"","bottom":"","shoes":"","height":"","style":""},"say":"...","choices":["..."],"done":false}`;
  const ask = async (extra) => {
    const { message } = await chat({ model: MODELS.fast, fallback: MODELS.smart, json: true, temperature: 0.5, maxTokens: 1500, messages: [{ role: 'system', content: sys }, ...hist, ...(extra ? [{ role: 'system', content: extra }] : [])] });
    try { return JSON.parse(message.content || '{}'); } catch { return { say: message.content || '' }; }
  };
  let out = await ask();
  // A question that calls for a choice must come with its ready answers: ask once more if they are missing.
  if (!out.done && !(Array.isArray(out.choices) && out.choices.length >= 2)) {
    const again = await ask('Your last reply had no "choices". Reply again with the same question and 2 to 4 short ready answers in "choices".');
    if (Array.isArray(again.choices) && again.choices.length >= 2) out = { ...out, say: again.say || out.say, choices: again.choices };
  }
  const s = { id: 'interview', title: tr(L, 'Get to know me'), userId: u.id };
  const saved = [];
  // What is no longer true goes away (a move, a breakup, someone who left).
  for (const id of (Array.isArray(out.forget) ? out.forget : []).slice(0, 6)) {
    if (typeof id === 'string' && /^mem_[0-9a-f]{8}$/.test(id)) forget(s, { id, scope: 'global' });
  }
  for (const f of (Array.isArray(out.save) ? out.save : []).slice(0, 6)) {
    const r = remember(s, { fact: f?.fact, kind: f?.kind, scope: 'global' });
    if (!r.error) saved.push(r.item.text);
  }
  // The people named go to "Your people" (who they are, their sizes, their email for PayPal requests), and the
  // user's own sizes to their profile: Mandat can then buy for them without asking again.
  const fresh = getUser(u.id);
  let changed = false;
  for (const p of (Array.isArray(out.people) ? out.people : []).slice(0, 5)) {
    const name = String(p?.name || '').trim().slice(0, 60);
    if (!name) continue;
    const email = String(p?.email || '').trim().slice(0, 120);
    const list = fresh.profile.people || (fresh.profile.people = []);
    let x = list.find((y) => y.name.toLowerCase() === name.toLowerCase());
    if (!x) { x = { name, email: '' }; list.push(x); }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) x.email = email;
    if (p.relation) x.relation = String(p.relation).trim().slice(0, 30);
    if (p.fit && typeof p.fit === 'object') x.fit = { ...(x.fit || {}), ...cleanFit(p.fit) };
    changed = true;
  }
  if (out.me && typeof out.me === 'object') {
    const f = cleanFit(out.me);
    if (Object.keys(f).length) { fresh.profile.fit = { ...(fresh.profile.fit || {}), ...f }; changed = true; }
  }
  if (changed) saveUser(fresh);
  return { say: String(out.say || '').slice(0, 400), choices: (Array.isArray(out.choices) ? out.choices : []).slice(0, 4).map((c) => String(c).slice(0, 60)), saved, done: out.done === true, user: publicUser(getUser(u.id)) };
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
  if (u.knowledge?.data) {
    const d = u.knowledge.data, gone = (x) => (x.ids || []).includes(req.params.id) && x.ids.length === 1;
    d.people = (d.people || []).map((p) => ({ ...p, details: p.details.filter((x) => !gone(x)) })).filter((p) => p.details.length);
    d.groups = (d.groups || []).map((g) => ({ ...g, items: g.items.filter((x) => !gone(x)) })).filter((g) => g.items.length);
    u.knowledge.hash = memHash(u.memory, u.knowledge.lang);
  }
  saveUser(u);
  return { user: publicUser(u) };
}));

// Forget everything the agent knows about me (profile and memory), keep PayPal connection and missions.
app.post('/api/me/forget', api(async (req, res) => {
  const u = me(req, res);
  // kept for a week, so a tap by mistake can be undone from Settings
  u.forgotten = { profile: u.profile, memory: u.memory, at: Date.now() };
  u.profile = newUser().profile;
  u.memory = [];
  delete u.knowledge;
  saveUser(u);
  return { user: publicUser(u) };
}));
app.post('/api/me/forget/undo', api(async (req, res) => {
  const u = me(req, res);
  if (!u.forgotten || Date.now() - u.forgotten.at > 7 * 864e5) throw Object.assign(new Error('Nothing to restore.'), { status: 404 });
  u.profile = u.forgotten.profile;
  u.memory = [...u.forgotten.memory, ...(u.memory || [])];
  delete u.forgotten;
  delete u.knowledge;
  saveUser(u);
  return { user: publicUser(u) };
}));

// Another account on this device: a fresh one (to start over, or to show the app from the first screen), and back.
// The account left behind is kept on the server and its id kept in a second cookie, so one tap brings it back.
const idCookie = (name, id) => `${name}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
app.post('/api/me/switch', api(async (req, res) => {
  const u = me(req, res);
  if (req.body?.to === 'previous') {
    const prev = getUser(cookie(req, 'mandat_prev'));
    if (!prev || prev.id === u.id) throw Object.assign(new Error('No previous account on this device.'), { status: 404 });
    res.setHeader('Set-Cookie', [idCookie('mandat_uid', prev.id), idCookie('mandat_prev', u.id)]);
    return { ok: true };
  }
  const hour = new Date().toISOString().slice(0, 13), key = req.ip + '|' + hour;
  if ((created.get(key) || 0) >= 40) throw Object.assign(new Error('Too many new visitors from this network. Please try again later.'), { status: 429 });
  created.set(key, (created.get(key) || 0) + 1);
  const fresh = newUser();
  saveUser(fresh);
  res.setHeader('Set-Cookie', [idCookie('mandat_uid', fresh.id), idCookie('mandat_prev', u.id)]);
  return { ok: true };
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
    const here = me(req, res);
    const tokenId = String(req.query.approval_token_id || here.pendingSetup || '');
    // Usually the same browser; from the installed app, PayPal ran in a Safari window with other cookies.
    const u = here.pendingSetup === tokenId ? here : userWithSetup(tokenId) || here;
    const elsewhere = u.id !== here.id;
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
    if (!elsewhere) return res.redirect('/?mandate=active');
    // Signed in a window over the app: say it is done; the app notices on its own.
    const fr = /^fr/i.test(req.get('accept-language') || '');
    res.type('html').send(`<!doctype html><html lang="${fr ? 'fr' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mandat</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ec;color:#111216;font:17px/1.4 -apple-system,system-ui,sans-serif;text-align:center}@media(prefers-color-scheme:dark){body{background:#0b0c10;color:#f5f5f7}}main{padding:32px}b{display:block;font-size:24px;margin:14px 0 6px}p{margin:0;opacity:.7}svg{width:56px;height:56px}</style></head>
<body><main><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#19a463"/><path d="m7 12.5 3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
<b>${fr ? 'Mandat est signé' : 'Mandate signed'}</b><p>${fr ? 'Vous pouvez fermer cette fenêtre et revenir à l’appli.' : 'You can close this window and go back to the app.'}</p></main>
<script>setTimeout(function(){try{window.close()}catch(e){}},1200)</script></body></html>`);
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
// AG Studio: the spending dashboard's data, and its agent's model calls (the key stays on the server).
app.get('/api/me/insights', api(async (req, res) => insightsData(me(req, res), getMission)));
// One payment's receipt (printable, saved as PDF from the browser), only for its owner.
app.get('/receipt/:id', (req, res) => {
  try {
    const u = getUser(cookie(req, 'mandat_uid'));
    const found = u && findPayment(u, getMission, String(req.params.id).slice(0, 80));
    if (!found) return res.status(404).type('text/plain').send('Receipt not found.');
    res.set('Cache-Control', 'no-store').type('html').send(receiptHtml(found, u, reqLang(req) === 'fr' || u.lang === 'fr' || String(req.query.lang) === 'fr' ? 'fr' : 'en', { embed: req.query.embed === '1' }));
  } catch (e) { res.status(500).type('text/plain').send('Receipt unavailable.'); }
});
app.get('/api/me/agenda', api(async (req, res) => agendaOf(me(req, res), getMission)));
// Pinned dates of the agenda: kept on the account, so they follow the user on every device.
app.post('/api/me/pins', api(async (req, res) => {
  const u = me(req, res);
  const id = String(req.body?.id || '').slice(0, 80);
  if (!/^s_[0-9a-f]+~\d+$/.test(id)) throw new Error('Bad pin');
  u.pins = (u.pins || []).filter((p) => p.id !== id);
  if (req.body?.on) u.pins.unshift({ id, date: String(req.body.date || '').slice(0, 16), label: String(req.body.label || '').slice(0, 80), mission: String(req.body.mission || '').slice(0, 80) });
  u.pins = u.pins.slice(0, 30);
  saveUser(u);
  return { pins: u.pins };
}));
app.get('/api/me/books', api(async (req, res) => ({ missions: booksOf(me(req, res), getMission, String(req.query.mission || '')) })));
app.post('/api/studio/llm', api(async (req, res) => {
  const u = me(req, res);
  allowance(u, 'studio');
  // The dashboard's agent has its own daily allowance, so it can never eat the missions' one, and only
  // requests shaped like AG Studio's (bounded conversation, tools and instructions) reach the model.
  if ((usage.studio || 0) >= LIMITS.studioGlobal) throw Object.assign(new Error(tr(u.lang, 'Mandat has reached its daily demo limit. Please come back tomorrow.')), { status: 429 });
  usage.studio = (usage.studio || 0) + 1;
  const body = req.body || {};
  if (!Array.isArray(body.input) || body.input.length > 160 || (body.tools || []).length > 40 || String(body.instructions || '').length > 30000 || JSON.stringify(body).length > 400000) throw new Error('Bad request');
  return studioTurn(body);
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
  if (!u.paypal.mandate) throw Object.assign(new Error('Sign the PayPal mandate first.'), { status: 409, code: 'mandate_required' });
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
  if (source === 'limit' && total < 1) throw Object.assign(new Error(tr(L, 'Your monthly limit ({cap}) is already planned. Raise it in Settings, or say a budget.', { cap: money(L, u.rules.monthlyCap) })), { status: 400, code: 'monthly_limit' });
  if (!(total > 0 && total <= 1000000)) throw new Error(tr(L, 'A mission budget goes from 1 to 1,000,000.'));
  if (used + total > u.rules.monthlyCap) throw Object.assign(new Error(tr(L, 'This would exceed your monthly limit ({cap}, {used} already planned).', { cap: money(L, u.rules.monthlyCap), used: money(L, used) })), { status: 400, code: 'monthly_limit' });
  allowance(u, 'missions');
  allowance(u, 'turns');
  const s = createSession({ budget: total, currency: currencyFromText(intent), approveAbove: approveAboveFor(u), purpose: intent.slice(0, 120), location, language: req.get('X-Lang') || req.headers['accept-language']?.slice(0, 5) || 'en', userId: u.id, emoji });
  s.envelope.source = source;
  s._voice = req.body?.voice === true;
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
  run(b, (emit) => userTurn(b.s, intent, emit, { images: imgs.map((i) => i.data), urls: imgs.map((i) => i.url) }));
  titleFor(intent).then(({ title, emoji: e }) => {
    if (b.deleted || b.s.titleByUser || (title === b.s.title && e === b.s.emoji)) return;
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
  return { summary: missionSummary(b.s, { busy: !!b.running }), envelope: envelopeView(b.s) };
}));

app.post('/api/missions/:id/messages', api(async (req, res) => {
  const u = me(req, res);
  const b = box(req.params.id, u);
  const text = String(req.body?.text || '').trim().slice(0, 2000);
  const imgs = saveImages(u, req.body?.images || (req.body?.image ? [req.body.image] : []));
  if (!text && !imgs.length) throw new Error('Empty message');
  allowance(u);
  emitter(b)('user', { text, images: imgs.map((i) => i.url) });
  b.s._voice = req.body?.voice === true; // a live voice conversation: short spoken replies
  run(b, (emit) => userTurn(b.s, text, emit, { images: imgs.map((i) => i.data), urls: imgs.map((i) => i.url) }));
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
    persist(path.join(MEDIA, u.id, name));
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
// Rename a mission (the generated title never overwrites a name you chose).
app.post('/api/missions/:id/title', api(async (req, res) => {
  const b = box(req.params.id, me(req, res));
  const title = String(req.body?.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!title) throw new Error('Give the mission a name.');
  b.s.title = title;
  b.s.titleByUser = true;
  saveMission(b.s);
  emitter(b)('title', { title });
  return { summary: missionSummary(b.s) };
}));
app.post('/api/missions/:id/archive', api(async (req, res) => {
  const b = box(req.params.id, me(req, res));
  b.s.archived = req.body?.archived !== false;
  saveMission(b.s);
  return { summary: missionSummary(b.s) };
}));
app.delete('/api/missions/:id', api(async (req, res) => {
  const u = me(req, res);
  const b = box(req.params.id, u);
  // Deleting stops Mandat at once, even mid-task, and releases any deposit still held: no money is taken.
  b.s._cancelled = true;
  b.deleted = true;
  for (const e of b.s.envelope.entries.filter((x) => x.state === 'held' && !x.capturing)) {
    try {
      if (e.paypal?.authorizationId) await PayPal.release({ authorizationId: e.paypal.authorizationId });
      e.state = 'released';
    } catch (err) { console.error('[delete] release', e.id, err.message); }
  }
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
  saveMission(b.s);
  return { ok: true };
}));

app.post('/api/missions/:id/stop', api(async (req, res) => {
  const b = box(req.params.id, me(req, res));
  const was = !!b.s.frozen;
  b.s.frozen = !!req.body?.stopped;
  emitter(b)('stopped', { stopped: b.s.frozen, scope: 'mission' });
  emitter(b)('summary', missionSummary(b.s));
  if (b.s.frozen) delete b.s._pauseSaid;
  saveMission(b.s);
  if (was && !b.s.frozen) {
    // Bookings a merchant confirmed during the pause are collected now, not before.
    for (const r of Object.values(b.s.requests || {}).filter((x) => x.collectOnResume)) {
      delete r.collectOnResume;
      await collectRequest(merchant(r.merchant_id), b.s, r).catch((e) => console.warn('[resume collect]', e.message));
    }
  }
  // Resumed: Mandat really picks up where it stopped (unless everything was already settled).
  if (was && !b.s.frozen && missionSummary(b.s).status !== 'done') run(b, (emit) => userTurn(b.s, '[system] The user resumed the mission. Continue exactly where you stopped; if nothing is left to do, say so in one short sentence.', emit));
  return { ok: true };
}));

app.post('/api/missions/:id/approvals/:aid', api(async (req, res) => {
  const u = me(req, res);
  const b = box(req.params.id, u);
  // The answer is recorded at once (the card closes and is never offered again), even if Mandat is busy;
  // the payment itself runs in turn. A second tap on the same approval does nothing.
  const ap = b.s.approvals?.[req.params.aid];
  if (!ap || ap.status !== 'pending') return { ok: true, already: true };
  ap.status = 'deciding';
  emitter(b)('approval_resolved', { id: ap.id || req.params.aid, approved: !!req.body?.approved });
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
  // the budget recorded in the history is as it was then: the books are counted again now
  try { res.write(`data: ${JSON.stringify({ type: 'envelope', data: envelopeView(b.s) })}\n\n`); } catch {}
  // payments waiting for the user are always sent, even when their card has left the replayed history
  const waiting = Object.values(b.s.approvals || {}).filter((x) => x.status === 'pending').map((x) => { try { return { ...x, place: placeOf(merchant(x.merchant_id)) }; } catch { return x; } });
  res.write(`data: ${JSON.stringify({ type: 'ready', data: { busy: !!b.running, approvals: waiting } })}\n\n`); // end of the replayed history
  b.clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    b.clients.delete(res);
  });
});

// The person's country from their time zone, to suggest their own street first.
const ZONE_CC = { 'Europe/Paris': 'fr', 'Europe/Brussels': 'be', 'Europe/Luxembourg': 'lu', 'Europe/Monaco': 'mc', 'Europe/Zurich': 'ch', 'Europe/London': 'gb', 'Europe/Dublin': 'ie', 'Europe/Madrid': 'es', 'Europe/Lisbon': 'pt', 'Europe/Rome': 'it', 'Europe/Berlin': 'de', 'Europe/Amsterdam': 'nl', 'Africa/Dakar': 'sn', 'Africa/Abidjan': 'ci', 'Africa/Casablanca': 'ma', 'Africa/Algiers': 'dz', 'Africa/Tunis': 'tn', 'Africa/Douala': 'cm', 'America/Montreal': 'ca', 'America/Toronto': 'ca' };
const countryOfZone = (tz) => ZONE_CC[tz] || (tz.startsWith('America/') && !/Montreal|Toronto|Vancouver|Mexico|Sao_Paulo|Buenos_Aires/.test(tz) ? 'us' : '');
// A human-sounding voice for the voice conversation (one sentence per call). 503 means: use the phone's voice.
app.get('/api/tts/status', (req, res) => res.json({ on: ttsEnabled() }));
app.post('/api/tts', async (req, res) => {
  try {
    const u = me(req, res);
    const mp3 = await synthesize(req.body?.text, reqLang(req) === 'fr' ? 'fr' : 'en', u.id);
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' }).send(mp3);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
// What you said in a voice conversation, written down (see lib/stt.mjs).
app.get('/api/stt', (req, res) => res.json({ on: sttEnabled() }));
app.post('/api/stt', async (req, res) => {
  try {
    const u = me(req, res);
    res.json({ text: await transcribe(req.body?.audio, reqLang(req) === 'fr' ? 'fr' : 'en', u.id) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
// Usual address: suggestions while typing, and "use my current location" turned into an address.
app.get('/api/geo/search', api(async (req) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q.length < 3) return [];
  return await searchAddress(q, req.get('X-Lang') === 'fr' ? 'fr' : 'en', countryOfZone(String(req.query.tz || '')));
}));
app.get('/api/geo/reverse', api(async (req) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('lat and lon');
  return await reverseAddress(lat.toFixed(5), lon.toFixed(5), req.get('X-Lang') === 'fr' ? 'fr' : 'en');
}));
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
  const acc = inboxAccess(m.id, req.query.k, req.query.r);
  const out = [];
  for (const s of missionsOnDisk()) for (const r of Object.values(s.requests || {})) {
    if (r.merchant_id !== m.id || (acc.rid && r.id !== acc.rid)) continue;
    const { sessionId, inbox, ...pub } = r;
    const pay = r.paymentId ? s.envelope.entries.find((e) => e.id === r.paymentId) : null;
    out.push({ ...pub, customer: r.customer ? String(r.customer).split(' ')[0] : 'A Mandat customer', deposit_state: pay?.state || null, deposit_held: pay?.amount || 0 });
  }
  return { merchant: { id: m.id, name: m.name, category: m.category, city: m.city, deposit: m.deposit }, requests: out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}));
app.post('/api/merchants/:mid/requests/:rid', api(async (req) => {
  const m = merchant(req.params.mid);
  inboxAccess(m.id, req.body?.k, req.params.rid);
  const action = ['accept', 'decline', 'counter'].includes(req.body?.action) ? req.body.action : null;
  if (!action) throw new Error('Choose accept, decline or counter');
  if (action === 'counter' && !String(req.body?.slot || '').trim()) throw new Error('Say which time you can do');
  const s = missionsOnDisk().find((x) => x.requests?.[req.params.rid]?.merchant_id === m.id);
  if (!s) throw Object.assign(new Error('Unknown request'), { status: 404 });
  const rq = s.requests[req.params.rid];
  if (rq.status !== 'pending' && !rq.move) throw Object.assign(new Error('This request was already answered.'), { status: 409 });
  const b = box(s.id);
  if (b.s.userId) b.s._user = getUser(b.s.userId);
  run(b, (emit) => resolveRequest(b.s, req.params.rid, { action, slot: req.body.slot, message: req.body.message }, emit));
  return { ok: true, status: action === 'accept' ? 'accepted' : action === 'counter' ? 'countered' : 'declined' };
}));

// The merchant confirms the booking: the held deposit is captured and paid to them.
app.post('/api/merchants/:mid/requests/:rid/collect', api(async (req) => {
  const m = merchant(req.params.mid);
  inboxAccess(m.id, req.body?.k, req.params.rid);
  const s = missionsOnDisk().find((x) => x.requests?.[req.params.rid]?.merchant_id === m.id);
  const r = s?.requests[req.params.rid];
  if (!r) throw Object.assign(new Error('Unknown request'), { status: 404 });
  return collectRequest(m, s, r);
}));
async function collectRequest(m, s, r) {
  const b = box(s.id);
  if (b.s.userId) b.s._user = getUser(b.s.userId);
  r = b.s.requests[r.id];
  const entry = b.s.envelope.entries.find((e) => e.id === r.paymentId);
  if (r.status !== 'accepted') throw Object.assign(new Error('This booking is not waiting for confirmation.'), { status: 409 });
  if (!entry || entry.state !== 'held') throw Object.assign(new Error('No deposit is waiting to be collected.'), { status: 409 });
  // Paused: nothing is paid. The deposit stays held and is collected when the user resumes.
  if (b.s.frozen) {
    r.collectOnResume = true;
    saveMission(b.s);
    return { ok: true, deferred: true };
  }
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
}

// ---------- demo merchants answer by themselves ----------
// Merchants without an AI agent answer from an inbox. In the sandbox nobody sits behind it, so each one
// answers like a small business would, 20 to 50 seconds later: it reads its own rules and the customer's
// note, then accepts (most of the time), proposes another time, or declines, with a short message; once the
// deposit is held it confirms the booking. Nothing waits for the user to play the merchant.
const handled = new Set();
const delayFor = (id, min, span) => min + (parseInt(crypto.createHash('md5').update(id).digest('hex').slice(0, 6), 16) % span);
async function demoMerchants() {
  if (process.env.MANDAT_MERCHANTS_AUTO === '0') return;
  const now = Date.now();
  for (const s0 of missionsOnDisk()) {
    for (const r of Object.values(s0.requests || {})) {
      let m;
      try { m = merchant(r.merchant_id); } catch { continue; }
      if (r.move && !handled.has(r.id + ':move:' + r.move.at) && now - Date.parse(r.move.at) > delayFor(r.id + r.move.at, 20000, 30000)) {
        handled.add(r.id + ':move:' + r.move.at);
        let act = { action: 'accept', message: '' };
        try {
          const { message } = await chat({ model: MODELS.fast, fallback: MODELS.smart, json: true, temperature: 0.4, maxTokens: 1500, timeoutMs: 30000, messages: [{ role: 'system', content: `You are ${m.name} (${m.category}, ${m.city}), a small business. A customer you already booked asks to move the booking to another time. Your house rules: ${m.rules}. Accept unless your rules make it impossible. JSON only: {"action":"accept|counter|decline","slot":"only for counter: the time you can do","message":"one short friendly sentence, in the language of the note"}` }, { role: 'user', content: `Booking: ${r.items.map((i) => i.qty + ' x ' + i.label).join(', ')}. Now booked for ${r.move.from}; asked to move to ${r.move.to}. Note: ${r.note || '(none)'}` }] });
          const o = JSON.parse(message.content || '{}');
          if (['accept', 'counter', 'decline'].includes(o.action)) act = { action: o.action, slot: o.slot, message: String(o.message || '').slice(0, 300) };
        } catch {}
        const b = box(s0.id);
        if (!b.deleted && b.s.requests?.[r.id]?.move) {
          if (b.s.userId) b.s._user = getUser(b.s.userId);
          run(b, (emit) => resolveRequest(b.s, r.id, act, emit).catch(() => {}));
        }
        continue;
      }
      const key = r.id + ':' + r.status;
      if (handled.has(key)) continue;
      if (r.status === 'pending' && now - Date.parse(r.createdAt) > delayFor(r.id, 20000, 30000)) {
        handled.add(key);
        let act = { action: 'accept', message: '' };
        try {
          const { message } = await chat({ model: MODELS.fast, fallback: MODELS.smart, json: true, temperature: 0.4, maxTokens: 1500, timeoutMs: 30000, messages: [{ role: 'system', content: `You are ${m.name} (${m.category}, ${m.city}), a small business answering a booking request from your inbox. Your house rules: ${m.rules}. Accept unless your rules make it impossible. If you work on site or deliver and the request does not say where, ask for the address (counter is not needed: accept and ask in your message). If the customer asks a question in their note, answer it briefly. JSON only: {"action":"accept|counter|decline","slot":"only for counter: the time you can do","message":"one or two friendly sentences, in the language of the note"}` }, { role: 'user', content: `Request: ${r.items.map((i) => i.qty + ' x ' + i.label).join(', ')}; when: ${r.slot || 'not given'}; where: ${r.where || 'not given'}; total ${r.total}. Note: ${r.note || '(none)'}` }] });
          const o = JSON.parse(message.content || '{}');
          if (['accept', 'counter', 'decline'].includes(o.action) && (o.action !== 'counter' || o.slot)) act = { action: o.action, slot: o.slot, message: String(o.message || '').slice(0, 300) };
        } catch {}
        const b = box(s0.id);
        if (b.deleted || b.s.requests?.[r.id]?.status !== 'pending') continue;
        if (b.s.userId) b.s._user = getUser(b.s.userId);
        run(b, (emit) => resolveRequest(b.s, r.id, act, emit).catch(() => {}));
      } else if (r.status === 'accepted' && r.paymentId) {
        const e = (s0.envelope.entries || []).find((x) => x.id === r.paymentId);
        if (e?.state === 'held' && now - Date.parse(e.at || r.createdAt) > delayFor(r.id + 'c', 15000, 20000)) {
          handled.add(key);
          await collectRequest(m, s0, r).catch(() => {});
        }
      }
    }
  }
}
setInterval(() => demoMerchants().catch((e) => console.error('[merchants]', e.message)), 10000).unref?.();

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
