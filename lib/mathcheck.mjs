// The numbers Mandat writes are checked by the code before anyone reads them: "60 guests at 29 €, that is
// 580 €" never reaches the screen. Products ("N at P € … so/makes/= X €") and sums ("A € + B € = C €") are
// recomputed; a wrong result is reported so the reply can be rewritten with the right one.
const NUM = String.raw`\d[\d   .,]*\d|\d`;
export function toNumber(raw) {
  let x = String(raw).replace(/[   ]/g, '');
  if (/,\d{1,2}$/.test(x)) x = x.replace(/\./g, '').replace(',', '.'); // 1.740,50 or 29,50
  else if (/\.\d{3}($|\D)/.test(x)) x = x.replace(/\./g, ''); // 1.740
  x = x.replace(/,/g, '');
  const v = Number(x);
  return Number.isFinite(v) ? v : NaN;
}
const near = (a, b) => Math.abs(a - b) <= Math.max(0.6, Math.abs(b) * 0.005);
const fmt = (v) => (Math.round(v * 100) / 100).toLocaleString('fr-FR');

const WORDS = { deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, quinze: 15, vingt: 20, trente: 30, two: 2, three: 3, four: 4, five: 5, six_: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
export function checkMath(text) {
  const errors = [];
  const t = String(text || '').replace(/\*\*/g, '').replace(/\b(deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|quinze|vingt|trente|two|three|four|five|seven|eight|nine|ten)\b/gi, (w) => String(WORDS[w.toLowerCase()]));
  // N (people, guests, nights, times…) at / × P € … so / makes / = / total X €
  const prod = new RegExp(String.raw`(${NUM})\s*(?:[a-zA-Zéèêàùûôîç'’ ]{0,24})?\s*(?:à|a|at|x|×|\*|de)\s*(${NUM})\s*(?:€|eur|euros)?\s*(?:par|per|each|chacun|l['’]unité|/)?[^.\n]{0,40}?(?:soit|font|fait|ça fait|cela fait|=|égale?|égal à|total(?:\s+de)?|makes|is|comes to)\s*(?:environ\s*)?(${NUM})\s*(?:€|eur|euros)`, 'gi');
  for (const m of t.matchAll(prod)) {
    const a = toNumber(m[1]), b = toNumber(m[2]), c = toNumber(m[3]);
    if ([a, b, c].some(Number.isNaN) || a < 2 || a > 2000 || b <= 0) continue;
    if (/environ/i.test(m[0])) continue;
    if (!near(a * b, c) && !near(a, c) && !near(b, c)) errors.push(`${fmt(a)} × ${fmt(b)} = ${fmt(a * b)} (not ${fmt(c)})`);
  }
  // A € + B € (+ C €) = X €
  const sum = new RegExp(String.raw`((?:${NUM})\s*€\s*(?:\+\s*(?:${NUM})\s*€\s*)+)=\s*(${NUM})\s*€`, 'g');
  for (const m of t.matchAll(sum)) {
    const parts = m[1].split('+').map((x) => toNumber(x.replace(/€/g, '')));
    const total = toNumber(m[2]);
    const real = parts.reduce((s, v) => s + v, 0);
    if (!parts.some(Number.isNaN) && !Number.isNaN(total) && !near(real, total)) errors.push(`${parts.map(fmt).join(' + ')} = ${fmt(real)} (not ${fmt(total)})`);
  }
  return errors;
}
