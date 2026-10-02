// Mandat's memory, in three layers:
// 1. the user's long-term memory (preferences, people, places, habits) — read by every mission;
// 2. each mission's own notes (constraints and decisions that must survive a long conversation),
//    plus a rolling summary of the older turns so the context stays small and cheap;
// 3. the agenda: what is already planned in the user's other missions, to catch clashes before booking.
import crypto from 'node:crypto';
import { getUser, saveUser, getMission } from './users.mjs';
import { localToUtc } from './calendar.mjs';
import { chat, MODELS } from './deepseek.mjs';

export const KINDS = ['preference', 'person', 'place', 'habit', 'constraint', 'fact'];
const MAX_GLOBAL = 80;
const MAX_MISSION = 30;
// Payment details, passwords and ID numbers never go into memory.
const SECRET = /\b(?:\d[ -]?){13,19}\b|\b(password|passcode|pin code|cvv|cvc|iban|social security|passport (no|number))\b/i;

const norm = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (t) => new Set(norm(t).split(' ').filter((w) => w.length > 2));
// Near-identical facts are merged instead of piling up ("likes quiet places" said twice).
function similarTo(a, b, min) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return norm(a) === norm(b);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size) >= min;
}
const similar = (a, b) => similarTo(a, b, 0.8);
function upsert(list, item, replaces, max) {
  let i = replaces ? list.findIndex((x) => x.id === replaces) : -1;
  if (i < 0) i = list.findIndex((x) => similar(x.text, item.text));
  if (i >= 0) {
    list[i] = { ...item, id: list[i].id, firstAt: list[i].firstAt || list[i].at };
    return { action: 'updated', item: list[i] };
  }
  list.push(item);
  while (list.length > max) list.shift();
  return { action: 'added', item };
}

// ---------- layers 1 and 2: what the agent remembers ----------
export function remember(s, { fact, kind = 'fact', scope = 'global', replaces } = {}) {
  const text = String(fact || '').trim().replace(/\s+/g, ' ').slice(0, 220);
  if (text.length < 3) return { error: 'Nothing to remember.' };
  if (SECRET.test(text)) return { error: 'Never store payment details, passwords or ID numbers.' };
  const item = { id: 'mem_' + crypto.randomBytes(4).toString('hex'), text, kind: KINDS.includes(kind) ? kind : 'fact', at: new Date().toISOString(), from: s.id, fromTitle: s.title || '' };
  if (scope === 'mission') {
    s.notes ||= [];
    const r = upsert(s.notes, item, replaces, MAX_MISSION);
    return { remembered: r.action, scope: 'mission', id: r.item.id, item: r.item };
  }
  const u = s.userId && getUser(s.userId); // fresh copy: other tabs may have changed the account
  if (!u) return { error: 'No account to remember this on.' };
  u.memory ||= [];
  const r = upsert(u.memory, item, replaces, MAX_GLOBAL);
  saveUser(u);
  if (s._user) s._user.memory = u.memory;
  return { remembered: r.action, scope: 'global', id: r.item.id, item: r.item };
}

export function forget(s, { id, scope } = {}) {
  if (scope !== 'global' && s.notes?.some((x) => x.id === id)) {
    s.notes = s.notes.filter((x) => x.id !== id);
    return { forgotten: true, scope: 'mission' };
  }
  const u = s.userId && getUser(s.userId);
  if (!u?.memory?.some((x) => x.id === id)) return { error: 'No memory with that id.' };
  u.memory = u.memory.filter((x) => x.id !== id);
  saveUser(u);
  if (s._user) s._user.memory = u.memory;
  return { forgotten: true, scope: 'global' };
}

// For the system prompt: stable between turns, so it stays in DeepSeek's cached prefix.
export function memoryBrief(user) {
  const list = user?.memory || [];
  if (!list.length) return '';
  const order = Object.fromEntries(KINDS.map((k, i) => [k, i]));
  return [...list].sort((a, b) => order[a.kind] - order[b.kind]).map((m) => `- [${m.id}] (${m.kind}) ${m.text}`).join('\n');
}
export const notesBrief = (s) => (s.notes || []).map((m) => `- [${m.id}] ${m.text}`).join('\n');

// ---------- layer 3: the agenda across missions ----------
const LEN = { transport: 150, activity: 120, food: 120, other: 60 };
const DAY = 864e5;
const fmtWhen = (when) => {
  const d = new Date(when.slice(0, 10) + 'T12:00:00Z');
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}${/\d{2}:\d{2}/.test(when) ? ' ' + when.match(/\d{2}:\d{2}/)[0] : ''}`;
};
// A plan line -> a time span (stays cover their nights, from 15:00 to 11:00 the last morning).
export function span(i, tz) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(i.when || '')) return null;
  const stay = i.kind === 'stay' || i.nights > 0;
  if (stay) {
    const start = localToUtc(i.when.slice(0, 10) + ' 15:00', tz).getTime();
    return { start, end: start + (i.nights || 1) * DAY - 4 * 3600e3, stay: true };
  }
  const timed = /\d{2}:\d{2}/.test(i.when);
  const start = localToUtc(timed ? i.when : i.when.slice(0, 10) + ' 09:00', tz).getTime();
  return { start, end: start + (timed ? LEN[i.kind] || 90 : 12 * 60) * 60000, stay: false, allDay: !timed };
}
const LIVE = new Set(['requested', 'awaiting_approval', 'held', 'confirmed', 'negotiating']);

// Everything the user has planned in their OTHER missions.
export function agenda(user, s, tz = 'UTC') {
  const out = [];
  for (const id of user?.missions || []) {
    if (id === s.id) continue;
    const m = getMission(id);
    if (!m || m.stopped) continue;
    for (const i of m.plan || []) {
      if (!LIVE.has(i.status)) continue;
      const sp = span(i, tz);
      if (sp) out.push({ ...sp, what: i.what, where: i.merchant || '', when: i.when, status: i.status, missionId: m.id, mission: m.title || 'another mission' });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
export function agendaBrief(events, now = Date.now()) {
  const next = events.filter((e) => e.end > now).slice(0, 14);
  return next.map((e) => `- ${fmtWhen(e.when)}${e.stay ? ` (stay${e.end - e.start > DAY ? ', several nights' : ''})` : ''} · ${e.what}${e.where ? ' — ' + e.where : ''} · ${e.status} · mission "${e.mission}"`).join('\n');
}
// The user's whole day, for check_schedule.
export function dayAgenda(user, s, date, tz = 'UTC') {
  const from = localToUtc(date + ' 00:00', tz).getTime();
  const to = from + DAY;
  const mine = (s.plan || []).filter((i) => i.status !== 'cancelled').map((i) => ({ ...span(i, tz), what: i.what, where: i.merchant || '', when: i.when, status: i.status, mission: 'this mission' })).filter((e) => e.start);
  return [...agenda(user, s, tz), ...mine].filter((e) => e.start < to && e.end > from).sort((a, b) => a.start - b.start)
    .map((e) => ({ when: e.when, what: e.what, where: e.where, status: e.status, mission: e.mission, ...(e.stay ? { stay: true } : {}) }));
}

// Clashes between these plan lines and the rest of the user's life (other missions, and each other).
export function clashes(user, s, items, tz = 'UTC') {
  const others = agenda(user, s, tz);
  const mine = items.filter((i) => i.status !== 'cancelled' && i.status !== 'idea').map((i) => ({ i, sp: span(i, tz) })).filter((x) => x.sp);
  const found = [];
  const BUFFER = 30 * 60000; // time to get from one place to the next
  const check = (a, b, sameMission) => {
    if (a.sp.stay && b.stay) {
      if (a.sp.start < b.end && b.start < a.sp.end) found.push({ type: 'double_stay', item: a.i, other: b, sameMission });
      return;
    }
    if (a.sp.stay !== b.stay) {
      // A dinner at home while a hotel stay elsewhere is booked: you will probably be away.
      if (sameMission) return;
      const [stay, ev] = a.sp.stay ? [a.sp, b] : [b, a.sp];
      if (!ev.allDay && ev.start >= stay.start && ev.start < stay.end) found.push({ type: 'away', item: a.i, other: b, sameMission });
      return;
    }
    if (a.sp.allDay || b.allDay) return;
    if (a.sp.start < b.end + BUFFER && b.start < a.sp.end + BUFFER) found.push({ type: a.sp.start < b.end && b.start < a.sp.end ? 'overlap' : 'too_close', item: a.i, other: b, sameMission });
  };
  // A line copied from another mission is the same booking, not a clash: leave it out.
  const copy = (x) => others.some((o) => o.when === x.i.when && (similarTo(o.what, x.i.what, 0.5) || (o.where && x.i.what.includes(o.where)) || /other mission|autre mission/i.test(x.i.what)));
  for (let k = mine.length - 1; k >= 0; k--) if (copy(mine[k])) mine.splice(k, 1);
  for (const x of mine) for (const o of others) check(x, o, false);
  for (let k = 0; k < mine.length; k++) {
    for (let j = k + 1; j < mine.length; j++) {
      const o = mine[j];
      check(mine[k], { ...o.sp, what: o.i.what, where: o.i.merchant || '', when: o.i.when, status: o.i.status, mission: 'this mission' }, true);
    }
  }
  return found.map((c) => ({
    key: `${c.type}|${c.item.what}|${c.item.when}|${c.other.what}|${c.other.when}`,
    type: c.type,
    what: c.item.what, when: c.item.when,
    with: { what: c.other.what, when: c.other.when, where: c.other.where, mission: c.other.mission, missionId: c.other.missionId || null },
    text: {
      overlap: `${c.item.what} (${fmtWhen(c.item.when)}) overlaps ${c.other.what} (${fmtWhen(c.other.when)}${c.sameMission ? '' : `, mission "${c.other.mission}"`}).`,
      too_close: `${c.item.what} (${fmtWhen(c.item.when)}) leaves under 30 minutes after or before ${c.other.what} (${fmtWhen(c.other.when)}${c.sameMission ? '' : `, mission "${c.other.mission}"`}).`,
      double_stay: `Two stays on the same night: ${c.item.what} and ${c.other.what}${c.sameMission ? '' : ` (mission "${c.other.mission}")`}.`,
      away: `${c.item.what} (${fmtWhen(c.item.when)}) falls during ${c.other.what}${c.sameMission ? '' : ` (mission "${c.other.mission}")`} — the user may be away.`,
    }[c.type],
  }));
}

// ---------- the conversation window: recent turns verbatim, older ones summarised ----------
const KEEP_MAX = 48; // messages sent as they are, at most
const KEEP_AFTER_CUT = 24;
// The cut only moves in jumps, so the prefix DeepSeek caches stays the same between turns.
export async function contextWindow(s) {
  const msgs = s.messages;
  let from = s.ctx?.from || 0;
  if (msgs.length - from > KEEP_MAX) {
    let cut = msgs.length - KEEP_AFTER_CUT;
    while (cut < msgs.length && msgs[cut].role !== 'user') cut++; // never split a tool call from its result
    if (cut < msgs.length && cut > from) {
      const older = msgs.slice(from, cut).filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content)).map((m) => `${m.role === 'user' ? 'User' : 'Mandat'}: ${String(m.content).slice(0, 600)}`).join('\n');
      let digest = s.ctx?.digest || '';
      try {
        const { message } = await chat({
          model: MODELS.fast, fallback: MODELS.smart, temperature: 0.2, maxTokens: 500,
          messages: [{ role: 'user', content: `Summarise this errand conversation for the assistant who continues it. Keep: what the user wants, constraints, decisions, what is booked or pending, open questions. Max 10 short bullets, no preamble.\n\n${digest ? 'Earlier summary:\n' + digest + '\n\n' : ''}Conversation:\n${older.slice(-12000)}` }],
        });
        digest = (message.content || '').trim().slice(0, 2500) || digest;
      } catch {
        digest = (digest + '\n' + older.slice(-1500)).slice(-2500); // the model is down: keep the raw tail
      }
      s.ctx = { from: cut, digest };
      from = cut;
    }
  }
  const head = s.ctx?.digest && from > 0 ? [{ role: 'system', content: `Earlier in this mission (summary of ${from} older messages):\n${s.ctx.digest}` }] : [];
  return [...head, ...msgs.slice(from)];
}
