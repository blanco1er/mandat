// Anonymous visit log for the hosted demo (what is kept is explained to visitors in public/privacy.html).
// It answers "did people try the demo, where did they come from, how far did they go?", never "who are they".
// - One JSON line per event in data/visits/YYYY-MM-DD.jsonl, mirrored to Cloudflare R2 like the rest of data/.
// - A visitor is a salted hash of address + browser: the address itself is never written.
// - A sentence typed to the agent is cut to 200 characters, with emails, phone and card numbers masked.
//   Passwords, tokens, PayPal ids and payer details are never logged.
// - The developer's own devices and scripts are flagged "internal" (header, or a cookie set by a secret link).
// - Only the developer reads it: GET /api/visits/export with a long secret token (MANDAT_VISITS_TOKEN), read by
//   scripts/visits-report.mjs. Without that variable the export does not exist.
// - Kept at least until 31 January 2027 (judging ends in December), deleted after MANDAT_VISITS_DELETE_AFTER
//   (31 March 2027 by default).
// Off entirely with MANDAT_VISITS=off.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { persist, enabled as r2 } from './store.mjs';

const DATA = path.resolve(process.env.MANDAT_DATA || 'data');
export const DIR = path.join(DATA, 'visits');
const env = (k) => process.env[k] || '';
const on = () => env('MANDAT_VISITS') !== 'off';
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

// ---------- salted, one-way ids ----------
// The salt: MANDAT_VISITS_SALT, else the server's own secret (Render generates MANDAT_NETWORK_SECRET), else a random
// salt kept next to the data, so ids stay the same across restarts.
let salt0 = null;
function salt() {
  if (salt0) return salt0;
  const e = env('MANDAT_VISITS_SALT') || env('MANDAT_NETWORK_SECRET');
  if (e) return (salt0 = e);
  const f = path.join(DATA, '.visits-salt');
  try {
    salt0 = fs.readFileSync(f, 'utf8').trim();
  } catch {}
  if (!salt0) {
    salt0 = crypto.randomBytes(32).toString('hex');
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(f, salt0, { mode: 0o600 });
      persist(f);
    } catch {}
  }
  return salt0;
}
const mac = (label, s) => crypto.createHmac('sha256', salt()).update(label + '|' + s).digest('hex');
const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
export const visitorId = (ip, ua) => 'v_' + mac('visitor', `${ip || ''}|${ua || ''}`).slice(0, 16);
// The account cookie is a key to the account: only its hash is logged.
export const accountId = (uid) => (uid ? 'a_' + mac('account', uid).slice(0, 12) : undefined);

// ---------- what a sentence may keep ----------
const DATE_LIKE = /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/;
export function maskText(s, max = 200) {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]');
  // "password: x", "mot de passe x", "token = x"…: the word stays, the value goes.
  t = t.replace(/\b(passwords?|passwd|mots? de passe|mdp)\b(\s*(?:is|est|:|=)?\s*)\S+/gi, '$1$2[hidden]');
  t = t.replace(/\b(pin|cvv|cvc|token|secret|api[ _-]?key)\b(\s*(?:[:=]|\bis\b|\best\b)\s*)\S+/gi, '$1$2[hidden]');
  t = t.replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, '[iban]');
  // Digits with short separators: 13 or more = a card, 9 to 12 = a phone number. Dates and amounts stay.
  t = t.replace(/(?:\+|\(|\b)\d(?:[\s().\/-]{0,2}\d){6,}/g, (m) => {
    const n = m.replace(/\D/g, '').length;
    if (n >= 13) return '[card]';
    if (n >= 9 && !DATE_LIKE.test(m.trim())) return '[phone]';
    return m;
  });
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ---------- browser, system, device (families only) ----------
export function uaInfo(ua = '') {
  const u = String(ua);
  const bot = /bot\b|bot\/|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl\/|wget|python|node-fetch|undici|axios|go-http|java\/|okhttp|headless|lighthouse|pingdom|uptime|monitor|render\//i.test(u) || !u;
  const br = /Instagram/.test(u) ? 'Instagram' : /FBAN|FBAV/.test(u) ? 'Facebook' : /LinkedInApp/.test(u) ? 'LinkedIn' : /Edg(?:e|A|iOS)?\//.test(u) ? 'Edge'
    : /OPR\/|Opera/.test(u) ? 'Opera' : /SamsungBrowser/.test(u) ? 'Samsung Internet' : /Firefox\/|FxiOS/.test(u) ? 'Firefox'
      : /Chrome\/|CriOS|Chromium/.test(u) ? 'Chrome' : /Safari\//.test(u) && /Version\//.test(u) ? 'Safari' : /AppleWebKit/.test(u) && /iPhone|iPad/.test(u) ? 'Safari (app)' : 'Other';
  const os = /iPhone|iPod/.test(u) ? 'iOS' : /iPad/.test(u) ? 'iPadOS' : /Android/.test(u) ? 'Android' : /CrOS/.test(u) ? 'ChromeOS' : /Windows/.test(u) ? 'Windows'
    : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : 'Other';
  const dev = /iPad|Tablet/.test(u) || (/Android/.test(u) && !/Mobile/.test(u)) ? 'tablet' : /Mobi|iPhone|iPod|Android/.test(u) ? 'mobile' : 'desktop';
  return { br, os, dev, ...(bot ? { bot: 1 } : {}) };
}

// Where the visit came from: the referring site's name only (devpost.com, youtube.com…).
export function refOf(referer, selfHost = '') {
  if (!referer) return 'direct';
  try {
    const h = new URL(referer).hostname.toLowerCase().replace(/^(www|m)\./, '');
    return h === String(selfHost).toLowerCase() ? 'self' : h.slice(0, 80) || 'other';
  } catch {
    return 'other';
  }
}

// ---------- the developer's own devices and scripts ----------
const token = () => { const t = env('MANDAT_VISITS_TOKEN'); return t.length >= 32 ? t : ''; };
const keyed = (t, label) => crypto.createHmac('sha256', t).update(label).digest('hex');
export const internalLinkKey = (t = token()) => (t ? keyed(t, 'internal-link').slice(0, 40) : '');
const internalCookie = () => { const t = token(); return t ? keyed(t, 'internal-cookie').slice(0, 40) : ''; };
function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y) && String(a) === String(b);
}
function cookieOf(req, name) {
  const m = String(req.headers?.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
export function isInternal(req) {
  if (String(req.headers?.['x-mandat-internal'] || '') === '1') return true; // scripts and recordings send this header
  const c = cookieOf(req, 'mandat_internal'), v = internalCookie();
  return !!(c && v && safeEq(c, v));
}

// The visit context of a request (computed once per request).
export function ctxOf(req) {
  try { return context(req); } catch (e) { console.warn('[visits]', e.message); return {}; }
}
function context(req) {
  if (req._visit) return req._visit;
  const ua = String(req.headers?.['user-agent'] || '').slice(0, 512);
  const uid = cookieOf(req, 'mandat_uid');
  const ctx = { v: visitorId(clientIp(req), ua), ...(/^u_[0-9a-f]{16}$/.test(uid) ? { a: accountId(uid) } : {}), ...uaInfo(ua), ...(isInternal(req) ? { int: 1 } : {}) };
  return (req._visit = ctx);
}
// Background events (the agent working, a merchant answering) are tied to the account's last request.
const byUser = new Map();
export function linkUser(req, uid) {
  try { return link(req, uid); } catch (e) { console.warn('[visits]', e.message); return {}; } // never in the app's way
}
function link(req, uid) {
  const ctx = ctxOf(req);
  if (uid) {
    ctx.a = accountId(uid);
    byUser.delete(uid);
    byUser.set(uid, ctx);
    if (byUser.size > 5000) byUser.delete(byUser.keys().next().value);
  }
  return ctx;
}
export const ctxForUser = (uid) => byUser.get(uid) || (uid ? { a: accountId(uid) } : {});

// ---------- writing ----------
const MAX_BYTES = () => Number(env('MANDAT_VISITS_MAX_MB') || 20) * 1e6; // per day: a robot cannot fill the disk
const CTX_KEYS = ['v', 'a', 'br', 'os', 'dev', 'bot', 'int'];
export function track(type, ctx = {}, data = {}) {
  if (!on()) return null;
  try {
    const now = new Date();
    const evt = { t: now.toISOString(), e: type };
    for (const k of CTX_KEYS) if (ctx[k] !== undefined) evt[k] = ctx[k];
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null || v === '' || CTX_KEYS.includes(k) || k === 't' || k === 'e') continue;
      evt[k] = typeof v === 'string' ? v.slice(0, 300) : typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 300);
    }
    const f = path.join(DIR, evt.t.slice(0, 10) + '.jsonl');
    fs.mkdirSync(DIR, { recursive: true });
    let size = 0;
    try { size = fs.statSync(f).size; } catch {}
    if (size > MAX_BYTES()) return null;
    fs.appendFileSync(f, JSON.stringify(evt) + '\n', { mode: 0o600 });
    persist(f);
    afterTrack(evt);
    return evt;
  } catch (e) {
    console.warn('[visits]', e.message);
    return null;
  }
}

// A page opened (the app, the privacy page, a merchant inbox).
const firstRef = new Map();
export const isPage = (p) => p === '/' || p === '/index.html' || p === '/privacy' || p === '/privacy.html' || /^\/merchant\/[\w-]+$/.test(p);
export function page(req) {
  try { return pageEvent(req); } catch (e) { console.warn('[visits]', e.message); return null; }
}
function pageEvent(req) {
  const ctx = ctxOf(req);
  const ref = refOf(req.headers?.referer, req.hostname);
  const q = req.query || {};
  const src = String(q.ref || q.utm_source || '').toLowerCase();
  if (ref !== 'self' && !firstRef.has(ctx.v)) {
    firstRef.set(ctx.v, ref);
    if (firstRef.size > 5000) firstRef.delete(firstRef.keys().next().value);
  }
  return track('page', ctx, { path: req.path.startsWith('/merchant/') ? '/merchant' : req.path.replace(/\.html$/, '').replace(/^\/index$/, '/'), ref, src: /^[\w.-]{1,40}$/.test(src) ? src : undefined });
}

// ---------- what the agent does (seen from the mission's event stream) ----------
const PAY = { held: 'authorized', captured: 'captured', released: 'voided', refunded: 'refunded' };
const payState = (e) => `${e.state}:${e.refunded || 0}`;
// Called once when a mission box is created or loaded, so only changes from then on are logged.
export function watch(b) {
  try { b._pay = new Map((b.s?.envelope?.entries || []).map((e) => [e.id, payState(e)])); } catch {}
  return b;
}
export function observe(b, type, data) {
  try { see(b, type, data); } catch (e) { console.warn('[visits]', e.message); } // the mission's events always go on
}
function see(b, type, data) {
  if (!on() || !b?.s) return;
  const s = b.s;
  if (!b._pay) watch(b);
  const ctx = () => ctxForUser(s.userId);
  if (type === 'tool') {
    b._tools = (b._tools || 0) + 1;
    track('tool', ctx(), { mid: s.id, name: String(data?.name || '').slice(0, 60) });
  } else if (type === 'plan' && data?.items?.length && !b._planSeen) {
    b._planSeen = true;
    track('plan', ctx(), { mid: s.id, items: data.items.length });
  } else if (type === 'approval' && data?.id && (!data.status || data.status === 'pending')) {
    b._apShown ||= new Set();
    if (!b._apShown.has(data.id)) {
      b._apShown.add(data.id);
      track('approval_shown', ctx(), { mid: s.id, amount: Number(data.amount) || undefined, cur: s.envelope?.currency });
    }
  } else if (type === 'approval_resolved' && data?.id) {
    b._apDone ||= new Set();
    if (!b._apDone.has(data.id)) {
      b._apDone.add(data.id);
      track('approval_answer', ctx(), { mid: s.id, approved: data.approved ? 1 : 0 });
    }
  } else if (type === 'error') {
    track('error', ctx(), { where: 'agent', mid: s.id, msg: maskText(data?.message, 160) });
  }
  if (type === 'payment' || type === 'envelope') {
    for (const e of s.envelope?.entries || []) {
      const now = payState(e), was = b._pay.get(e.id);
      if (now === was) continue;
      b._pay.set(e.id, now);
      const refundedBefore = Number(String(was || '').split(':')[1]) || 0;
      const state = (e.refunded || 0) > refundedBefore ? 'refunded' : PAY[e.state] || String(e.state);
      track('payment', ctx(), { mid: s.id, state, amount: state === 'refunded' ? Math.round(((e.refunded || 0) - refundedBefore) * 100) / 100 : e.amount, cur: s.envelope?.currency, mode: e.paypal?.mode });
    }
  }
}

// ---------- reading (developer only) ----------
export function readEvents(since = '0000-00-00', until = '9999-99-99') {
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => DAY_FILE.test(f)).sort(); } catch {}
  const out = [];
  for (const f of files) {
    const day = f.slice(0, 10);
    if (day < since || day > until) continue;
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out;
}
export function authorized(req) {
  const t = token();
  const m = /^Bearer\s+(\S+)$/.exec(String(req.headers?.authorization || ''));
  return !!(t && m && safeEq(m[1], t));
}
const fails = new Map();
export function exportRoute(req, res) {
  res.set('Cache-Control', 'no-store');
  const ip = clientIp(req), hour = new Date().toISOString().slice(0, 13), key = ip + '|' + hour;
  if ((fails.get(key) || 0) >= 20) return res.status(429).json({ error: 'Too many attempts' });
  if (!authorized(req)) {
    fails.set(key, (fails.get(key) || 0) + 1);
    if (fails.size > 5000) fails.clear();
    return res.status(404).json({ error: 'Not found' });
  }
  const day = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : null);
  res.json({ storage: r2 ? 'r2' : 'disk', keepUntil: KEEP_UNTIL, deleteAfter: deleteAfter(), events: readEvents(day(req.query.since) || '0000-00-00', day(req.query.until) || '9999-99-99') });
}
// The secret link the developer opens once on each device: from then on, that browser is "internal".
export function internalRoute(req, res) {
  res.set('Cache-Control', 'no-store');
  const k = internalLinkKey();
  if (!k || !safeEq(String(req.query.k || ''), k)) return res.status(404).type('text/plain').send('Not found');
  res.setHeader('Set-Cookie', `mandat_internal=${internalCookie()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${400 * 86400}${req.secure ? '; Secure' : ''}`);
  res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mandat</title><body style="font:17px/1.4 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;text-align:center"><main><b>Cet appareil est exclu du suivi des visites.</b><p><a href="/">Ouvrir Mandat</a></p></main>');
}
// The app's two signals: how long the page stayed open, and an error it hit (never what was typed).
const beacons = new Map();
export function beaconRoute(req, res) {
  res.status(204);
  const ctx = ctxOf(req), hour = new Date().toISOString().slice(0, 13), key = ctx.v + '|' + hour;
  const n = beacons.get(key) || 0;
  if (n >= 60) return res.end();
  beacons.set(key, n + 1);
  if (beacons.size > 5000) beacons.clear();
  const b = req.body || {};
  if (b.t === 'leave' && Number.isFinite(b.ms)) track('leave', ctx, { ms: Math.min(Math.max(0, Math.round(b.ms)), 864e5) });
  else if (b.t === 'client_error') track('client_error', ctx, { msg: maskText(b.msg, 160), src: String(b.src || '').replace(/[^\w./:-]/g, '').slice(0, 80) || undefined });
  res.end();
}

// ---------- retention ----------
export const KEEP_UNTIL = '2027-01-31';
export function deleteAfter() {
  const d = env('MANDAT_VISITS_DELETE_AFTER');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '2027-03-31';
  return d < KEEP_UNTIL ? KEEP_UNTIL : d; // never before the end of January 2027
}
// After the deletion date, every day file up to that date is removed (here and in R2). Only visit files.
export function purge(now = new Date()) {
  const today = now.toISOString().slice(0, 10), limit = deleteAfter();
  if (today <= limit) return 0;
  let n = 0;
  let files = [];
  try { files = fs.readdirSync(DIR); } catch {}
  for (const f of files) {
    const m = DAY_FILE.exec(f);
    if (!m || m[1] > limit) continue;
    fs.rmSync(path.join(DIR, f), { force: true });
    persist(path.join(DIR, f)); // the mirror deletes it too
    n++;
  }
  return n;
}
export function startHousekeeping() {
  const run = () => { try { const n = purge(); if (n) console.log(`[visits] ${n} old day files deleted`); } catch (e) { console.warn('[visits]', e.message); } };
  run();
  setInterval(run, 12 * 3600e3).unref();
}

// ---------- optional alert: at most once an hour, when a new outside visitor starts a mission ----------
// MANDAT_VISITS_ALERT_URL: any URL taking a plain-text POST, e.g. https://ntfy.sh/<a long secret topic> (free, no
// account: the ntfy app on the phone shows it). Optional: MANDAT_VISITS_ALERT_EMAIL (ntfy "Email" header, needs a
// free ntfy account) and MANDAT_VISITS_ALERT_AUTH (its access token). No visitor data is sent beyond the source site,
// the device family and the time.
const HOUR = () => Number(env('MANDAT_VISITS_ALERT_EVERY_MS') || 3600e3);
const alerts = { last: 0, pending: [], timer: null, seen: new Set(), sent: 0 };
function afterTrack(evt) {
  if (evt.e !== 'mission_new' || evt.int || evt.bot || !env('MANDAT_VISITS_ALERT_URL')) return;
  const who = evt.v || evt.a;
  if (!who || alerts.seen.has(who)) return;
  alerts.seen.add(who);
  alerts.pending.push({ at: evt.t, ref: firstRef.get(evt.v) || '?', dev: evt.dev, os: evt.os });
  if (!alerts.timer) {
    alerts.timer = setTimeout(sendAlert, Math.max(0, alerts.last + HOUR() - Date.now()));
    alerts.timer.unref?.();
  }
}
async function sendAlert() {
  alerts.timer = null;
  const list = alerts.pending.splice(0);
  if (!list.length) return;
  alerts.last = Date.now();
  const name = env('MANDAT_VISITS_NAME') || env('RENDER_SERVICE_NAME') || 'Mandat';
  const body = `${list.length} nouveau${list.length > 1 ? 'x' : ''} visiteur${list.length > 1 ? 's' : ''} externe${list.length > 1 ? 's' : ''} avec une mission sur ${name} :\n`
    + list.map((x) => `- ${x.at.slice(11, 16)} UTC · ${x.ref} · ${x.dev || '?'} ${x.os || ''}`.trim()).join('\n')
    + '\nDétail : node scripts/visits-report.mjs';
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', Title: `${name}: new visitor`.replace(/[^\x20-\x7e]/g, '') };
  if (env('MANDAT_VISITS_ALERT_EMAIL')) headers.Email = env('MANDAT_VISITS_ALERT_EMAIL');
  if (env('MANDAT_VISITS_ALERT_AUTH')) headers.Authorization = 'Bearer ' + env('MANDAT_VISITS_ALERT_AUTH');
  try {
    const r = await fetch(env('MANDAT_VISITS_ALERT_URL'), { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    alerts.sent++;
  } catch (e) {
    console.warn('[visits] alert not sent:', e.message);
  }
}
export const alertState = () => ({ sent: alerts.sent, pending: alerts.pending.length, last: alerts.last });
