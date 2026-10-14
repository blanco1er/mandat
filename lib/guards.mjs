// Small checks the code makes whatever the model says: the language a request is written in, the time a
// merchant really proposes, and what must be ordered from a local merchant rather than shipped as a product.

// English or French, from the words themselves (a title follows the request, not the phone).
const FR = /\b(le|la|les|un|une|des|du|pour|avec|et|mon|ma|mes|ton|ta|tes|dans|sur|chez|demain|samedi|dimanche|vendredi|soir|anniversaire|dîner|gâteau|fleurs|personnes|réserve|trouve|je|j'|moi|max)\b/gi;
const EN = /\b(the|a|an|for|with|and|my|your|in|on|at|near|tomorrow|saturday|sunday|friday|evening|birthday|dinner|cake|flowers|people|book|find|i|me|get|turns)\b/gi;
export function textLang(text, fallback = 'en') {
  const t = String(text || '');
  const fr = (t.match(FR) || []).length + (/[éèêàùçœ]/i.test(t) ? 1 : 0);
  const en = (t.match(EN) || []).length;
  if (fr === en) return fallback;
  return fr > en ? 'fr' : 'en';
}

// "20:00", "8pm", "8:30 PM", "20h", "20h30", "2026-10-17 19:00" → minutes after midnight; null if no time.
export function minutesOf(str) {
  const s = String(str || '');
  let m = /\b(\d{1,2})(?::|h|\.)(\d{2})\s*(am|pm)?\b/i.exec(s) || /\b(\d{1,2})\s*(am|pm)\b/i.exec(s) || /\b(\d{1,2})\s*h\b/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] && /^\d{2}$/.test(m[2]) ? Number(m[2]) : 0;
  const ap = (m[3] || (m[2] && !/^\d/.test(m[2]) ? m[2] : '') || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// The merchant proposes another time than the one asked for (more than 15 minutes apart).
export function otherTime(asked, proposed) {
  const a = minutesOf(asked), p = minutesOf(proposed);
  return a !== null && p !== null && Math.abs(a - p) > 15;
}

// A cake, pastries or flowers are made and delivered by a local merchant: the network first, never a shipped product.
const LOCAL = [
  [/\b(cakes?|gâteaux?|gateaux?|pâtisseries?|patisseries?|pastr(y|ies)|cupcakes?|macarons?|tartes?|tarts?|birthday cake)\b/i, 'bakery'],
  [/\b(flowers?|fleurs?|bouquets?|roses?|tulips?|tulipes?|pivoines?|peonies|lilies|lys)\b/i, 'florist'],
];
const NOT_LOCAL = /\b(perfumes?|parfums?|candles?|bougies?|vases?|tins?|moules?|plates?|assiettes?|stands?|toppers?|posters?|artificial|artificiel|seeds?|graines?|wrapping|ribbon|ruban)\b/i;
export function localCategory(query) {
  const q = String(query || '');
  if (NOT_LOCAL.test(q)) return null;
  for (const [re, cat] of LOCAL) if (re.test(q)) return cat;
  return null;
}

// The model thinking out loud in the message itself ("Wait compute: … Actually we had …"): never shown as is.
const DELIBERATION = /(\bWait[,:]? (compute|let me|let's|we|I|actually)\b|\bLet me (re-?)?(compute|calculate|check|recount)\b|\bcompute:|\bActually,? (we|I) (had|have|need)\b|\bHmm\b|\bAttends,? (je|on) (calcule|recalcule)\b)/i;
export const deliberates = (text) => DELIBERATION.test(String(text || ''));

// Every time written in a text, in order, without repeats: "taken at 20:00; we can do 19:00, 19:30 or 21:15".
export function timesIn(str) {
  const out = [];
  for (const m of String(str || '').matchAll(/\b\d{1,2}(?::\d{2}|h\d{2}|\s*(?:am|pm)|h)\b/gi)) {
    const v = minutesOf(m[0]);
    if (v !== null && !out.includes(v)) out.push(v);
  }
  return out;
}
export const hhmm = (v) => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
// The other times a merchant offers, when the one asked is not possible: [] if they took the time asked.
export function otherTimesOffered(asked, reply, slot) {
  const a = minutesOf(asked);
  if (a === null) return [];
  if (slot) return otherTime(asked, slot) ? [minutesOf(slot)].filter((v) => v !== null).map(hhmm) : [];
  const t = timesIn(reply);
  // They take the time asked ("confirmed for 8pm, we close at 23:00"): the other times are only details.
  if (t.includes(a) && /\b(confirm\w*|available|works|booked for|yes|ok|d'accord|parfait)\b/i.test(reply) && !/\b(taken|full|unavailable|not available|cannot|can't|sorry|complet|pas possible|désolé)\b/i.test(reply)) return [];
  const others = t.filter((v) => Math.abs(v - a) > 15);
  // The time asked is named and others too: they offer the others instead (or the reply only repeats it).
  return others.length ? others.slice(0, 4).map(hhmm) : [];
}

// Once the work has started, the user is asked again only when a decision really needs them: a time, money,
// an address or a date, booking or cancelling. A question of taste (a flavour, a colour, a style) is decided.
const NEEDS_USER = /[€$£]|\b\d+(?:[.,]\d+)?\s?(?:eur|euros?)\b|\b(budget|price|prix|cost|coût|pay|payer|address|adresse|where|où|date|day|jour|tomorrow|demain|book it|réserve|confirm\w*|approv\w*|cancel\w*|annul\w*|refund\w*|rembours\w*|instead|à la place|elsewhere|ailleurs|works|convient)\b/i;
export function needsUser(text) {
  const t = String(text || '');
  return minutesOf(t) !== null || NEEDS_USER.test(t);
}
