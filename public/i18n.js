// Interface language: French or English, from the phone's language, or the one chosen in Settings.
// Gettext style: t('English text', { vars }) gives the French text when the app is in French.
// The French table (i18n-fr.js) is keyed by the exact English source string.
import FR from '/i18n-fr.js';

export const LANGS = { en: 'English', fr: 'Français' };
const TABLES = { fr: FR };
const KEY = 'mandat_lang';

// Automatic: French when French is among the phone's languages, or when the phone is in a French-speaking
// country (its time zone or region): an English phone in France gets French. English everywhere else.
const FR_REGIONS = new Set('FR BE LU MC CH SN CI CM ML BF NE TG BJ GA CG CD MG GN TD CF DJ KM HT MA DZ TN RE GP MQ GF YT NC PF PM BL MF WF'.split(' '));
const FR_ZONES = /^(Europe\/(Paris|Brussels|Luxembourg|Monaco)|Africa\/(Dakar|Abidjan|Douala|Bamako|Ouagadougou|Niamey|Lome|Porto-Novo|Libreville|Brazzaville|Kinshasa|Lubumbashi|Conakry|Ndjamena|Bangui|Djibouti|Casablanca|Algiers|Tunis)|Indian\/(Antananarivo|Reunion|Mayotte|Comoro)|America\/(Guadeloupe|Martinique|Cayenne|Port-au-Prince)|Pacific\/(Noumea|Tahiti))$/;
export function autoLang(languages = navigator.languages?.length ? navigator.languages : [navigator.language || 'en'], zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '') {
  const list = [...languages].map(String);
  if (list.some((l) => /^fr(\b|[-_])/i.test(l))) return 'fr';
  const region = /^[a-z]{2,3}[-_](?:[A-Za-z]{4}[-_])?([A-Za-z]{2})\b/i.exec(list[0] || '')?.[1]?.toUpperCase();
  // The country decides: the phone's clock or its region is in a French-speaking country.
  return FR_ZONES.test(zone) || (region && FR_REGIONS.has(region)) ? 'fr' : 'en';
}
function pick() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'fr') return saved;
  } catch {}
  return autoLang();
}
export const lang = pick();
export const locale = () => (lang === 'fr' ? 'fr-FR' : 'en-GB');
document.documentElement.lang = lang;

// The saved choice: 'en', 'fr', or 'auto' (follow the phone).
export function chosenLang() {
  try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; }
}
export function setLang(l) {
  try {
    if (l === 'en' || l === 'fr') localStorage.setItem(KEY, l);
    else localStorage.removeItem(KEY);
  } catch {}
  location.reload();
}

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m)) : s);
export function t(text, vars) {
  return fill(TABLES[lang]?.[text] ?? text, vars);
}
// Counts: tn(n, '{n} step', '{n} steps') picks the right form for the language (French: 0 and 1 are singular).
const rules = new Intl.PluralRules(lang);
export function tn(n, one, other, vars = {}) {
  return t(rules.select(n) === 'one' ? one : other, { n, ...vars });
}

// ---------- static text: the HTML is written in English and translated in place ----------
// An element with data-i18n is translated as a whole (its English innerHTML is the key, e.g. a title with <br>).
// Anything else: text nodes and a few attributes whose trimmed value is exactly a key.
const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
// Never translate what people or agents wrote: messages, replies, merchant bubbles.
const SKIP = '.say, .u-text, .bubbles, .req-reply, .req-note, [data-no-i18n]';
const norm = (s) => s.replace(/\s+/g, ' ').trim();

function trText(node) {
  const raw = node.nodeValue;
  const key = raw.trim();
  if (!key) return;
  const fr = TABLES[lang]?.[key];
  if (fr !== undefined && fr !== key) node.nodeValue = raw.replace(key, fr);
}
function trAttrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    const fr = TABLES[lang]?.[v.trim()];
    if (fr !== undefined && fr !== v) el.setAttribute(a, fr);
  }
}
function trElement(el) {
  if (el.closest(SKIP)) return;
  if (el.hasAttribute('data-i18n')) {
    const fr = TABLES[lang]?.[norm(el.innerHTML)];
    if (fr !== undefined) el.innerHTML = fr;
    return;
  }
  trAttrs(el);
}
export function translateDom(root = document.body) {
  if (!TABLES[lang]) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
      if (n.matches(SKIP) || n.matches('script, style, svg')) return NodeFilter.FILTER_REJECT;
      if (n.matches('textarea')) { trAttrs(n); return NodeFilter.FILTER_REJECT; } // its placeholder, never its text
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  if (root.nodeType === 1) trElement(root);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) { if (!n.parentElement?.closest('[data-i18n]')) trText(n); }
    else if (n.hasAttribute('data-i18n')) { trElement(n); }
    else trAttrs(n);
  }
}
// Safety net: exact-match text or attributes added later are translated too.
function watch() {
  if (!TABLES[lang]) return;
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes') {
        if (!m.target.closest(SKIP)) trAttrs(m.target);
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType === 3) { if (n.parentElement && !n.parentElement.closest(SKIP)) trText(n); }
        else if (n.nodeType === 1 && !n.closest(SKIP)) translateDom(n);
      }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ATTRS });
}
export function applyI18n() {
  translateDom();
  watch();
}
