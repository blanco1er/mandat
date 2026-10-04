// Calendar files (.ics, RFC 5545) for plans and reminders, read by iPhone Calendar, Google Calendar and Outlook,
// plus local-time helpers: the agent speaks in the user's time zone, the server keeps UTC.

const pad = (n) => String(n).padStart(2, '0');

// Offset (ms) of a time zone at a given instant.
function tzOffset(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - ms;
}
export const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

// "2026-10-03 17:00" in Europe/Paris -> Date (UTC instant). Returns null when it is not a date-time.
export function localToUtc(local, tz = 'UTC') {
  const m = String(local || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz); // second pass across DST changes
  return new Date(t);
}
// The user's "now", as the agent should read it.
export function localNow(tz = 'UTC') {
  const d = new Date(Date.now() + tzOffset(Date.now(), tz));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]})`;
}

// The next two weeks as exact dates, so "this Saturday" or "next Friday" is read from a calendar, not guessed.
export function nextDays(tz = 'UTC', n = 15) {
  const now = new Date(Date.now() + tzOffset(Date.now(), tz));
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i, 12));
    out.push(`${i === 0 ? 'today ' : i === 1 ? 'tomorrow ' : ''}${names[d.getUTCDay()]} ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  return out.join('; ');
}

const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
const dateOnly = (s) => s.slice(0, 10).replace(/-/g, '');
const addDays = (s, n) => { const d = new Date(s.slice(0, 10) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const text = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Lines longer than 75 octets are folded, as the format requires.
const fold = (line) => line.match(/.{1,73}/gu).join('\r\n ');

// events: [{ uid, summary, start: "YYYY-MM-DD[ HH:MM]", minutes?, days?, location?, description?, alarms?: [minutes before] }]
export function ics(name, events, tz = 'UTC') {
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mandat//Plans and reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${text(name)}`];
  const now = stamp(new Date());
  for (const e of events) {
    const timed = /\d{2}:\d{2}/.test(e.start);
    out.push('BEGIN:VEVENT', `UID:${e.uid}@mandat`, `DTSTAMP:${now}`, `SUMMARY:${text(e.summary)}`);
    if (timed) {
      const s = localToUtc(e.start, tz);
      out.push(`DTSTART:${stamp(s)}`, `DTEND:${stamp(new Date(s.getTime() + (e.minutes || 60) * 60000))}`);
    } else {
      out.push(`DTSTART;VALUE=DATE:${dateOnly(e.start)}`, `DTEND;VALUE=DATE:${dateOnly(addDays(e.start, e.days || 1))}`);
    }
    if (e.location) out.push(`LOCATION:${text(e.location)}`);
    if (e.description) out.push(`DESCRIPTION:${text(e.description)}`);
    for (const m of e.alarms || (timed ? [60] : [15 * 60])) out.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(e.summary)}`, `TRIGGER:-PT${m}M`, 'END:VALARM');
    out.push('END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.map(fold).join('\r\n') + '\r\n';
}

// A mission plan -> calendar events (only lines with a date; stays become all-day events over their nights).
export function planEvents(s) {
  const LEN = { transport: 150, activity: 120, food: 120, other: 60 };
  return (s.plan || [])
    .filter((i) => i.status !== 'cancelled' && /^\d{4}-\d{2}-\d{2}/.test(i.when || ''))
    .map((i, n) => {
      const stay = i.kind === 'stay' || i.nights > 0;
      return {
        uid: `${s.id}-${n}`,
        summary: i.what,
        start: stay ? i.when.slice(0, 10) : i.when,
        minutes: LEN[i.kind] || 90,
        days: stay ? i.nights || 1 : 1,
        location: i.merchant || '',
        description: `${s.title || 'Mandat mission'}${i.total ? ` · ${i.total} ${s.envelope.currency}` : ''} · status: ${i.status}. Planned with Mandat.`,
        alarms: stay ? [15 * 60] : [24 * 60, 60],
      };
    });
}

// The Agenda tab (Bryntum Calendar): every dated step of every mission, one colour per mission. Times are
// the user's local times, as the plan stores them. When the text gives a range ("17h-23h", "17:30-22:00"),
// the event ends there; otherwise it lasts as long as that kind of step usually does.
const AGENDA_COLORS = ['blue', 'orange', 'green', 'violet', 'red', 'teal', 'indigo', 'pink', 'lime', 'amber'];
function rangeEnd(text, start) {
  // only a range that starts when the booking starts ("17h-23h" for a 17:00 booking), never "moved from 10h to 13h30"
  const m = String(text || '').match(/(\d{1,2})\s*[h:](\d{2})?\s*[-–]\s*(\d{1,2})\s*[h:](\d{2})?/i);
  if (!m || `${m[1].padStart(2, '0')}:${m[2] || '00'}` !== start.slice(11, 16)) return null;
  let end = `${start.slice(0, 10)} ${m[3].padStart(2, '0')}:${m[4] || '00'}`;
  if (end <= start) { // "19h-01h" ends the next day
    const d = new Date(start.slice(0, 10) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    end = `${d.toISOString().slice(0, 10)} ${end.slice(11)}`;
  }
  return end;
}
export function agendaOf(u, getMission) {
  const LEN = { transport: 150, activity: 120, food: 120, other: 60 };
  const missions = [], events = [];
  for (const id of u.missions) {
    const s = getMission(id);
    if (!s) continue;
    const items = (s.plan || []).map((i, n) => ({ i, n })).filter(({ i }) => i.status !== 'cancelled' && /^\d{4}-\d{2}-\d{2}/.test(i.when || ''));
    // an order shows its estimated delivery window once it is paid (not refunded or released)
    const deliveries = (s.deliveries || []).map((d, k) => ({ d, k })).filter(({ d }) => s.envelope.entries.some((e) => e.label === d.label && (e.state === 'held' || e.state === 'captured')));
    if (!items.length && !deliveries.length) continue;
    missions.push({ id: s.id, name: s.title || 'Mission', eventColor: AGENDA_COLORS[missions.length % AGENDA_COLORS.length] });
    for (const { i, n } of items) {
      const stay = i.kind === 'stay' || i.nights > 0;
      const timed = /\d{2}:\d{2}/.test(i.when);
      const start = timed ? i.when.slice(0, 16) : i.when.slice(0, 10);
      let end = null;
      if (stay) end = new Date(Date.parse(i.when.slice(0, 10) + 'T00:00:00Z') + (i.nights || 1) * 864e5).toISOString().slice(0, 10);
      else if (timed) end = rangeEnd(i.what, start) || (() => { const d = new Date(start.replace(' ', 'T') + ':00Z'); d.setUTCMinutes(d.getUTCMinutes() + (LEN[i.kind] || 90)); return d.toISOString().slice(0, 16).replace('T', ' '); })();
      // An evening that ends after midnight (before 6:00) stays on its own day in the list; the real end is
      // kept for the time shown ("14:00 → 01:00").
      let realEnd = end;
      if (end && !stay && end.slice(0, 10) > start.slice(0, 10) && end.slice(11, 13) < '06') end = `${start.slice(0, 10)} 23:59`;
      events.push({
        realEnd: realEnd ? realEnd.replace(' ', 'T') : undefined,
        pinned: (u.pins || []).some((p) => p.id === `${s.id}~${n}`),
        id: `${s.id}~${n}`, resourceId: s.id, mission: s.title || 'Mission', name: i.what, where: i.merchant || '', status: i.status || '', total: i.total || 0, currency: s.envelope.currency,
        startDate: start.replace(' ', 'T'), endDate: end ? end.replace(' ', 'T') : undefined, allDay: stay || !timed,
      });
    }
    for (const { d, k } of deliveries) {
      const id = `${s.id}~d${k}`;
      events.push({
        id, resourceId: s.id, mission: s.title || 'Mission', name: `${u.lang === 'fr' ? 'Livraison estimée' : 'Estimated delivery'} · ${d.title}`, where: d.retailer, status: 'confirmed', total: 0, currency: s.envelope.currency,
        pinned: (u.pins || []).some((p) => p.id === id), delivery: true, draggable: false, resizable: false,
        startDate: d.from, endDate: new Date(Date.parse(d.to + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10), allDay: true,
      });
    }
  }
  return { missions, events, pins: (u.pins || []).slice(0, 30) };
}
