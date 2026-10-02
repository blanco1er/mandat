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
