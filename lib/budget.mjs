// Reads the budget from the user's own words: "700 €", "$300", "budget 250", "max 80 euros",
// "around 40 € each" for 4 people (= 160), "1.5k". Shared by the server and the app (served as /budget.mjs).

const NUM = String.raw`(\d{1,3}(?:[ .,  ]\d{3})+|\d+(?:[.,]\d{1,2})?)(\s?k\b)?`;
const PATTERNS = [
  new RegExp(String.raw`(?:€|\$|£|\beur\b|\busd\b)\s?${NUM}`, 'i'),
  new RegExp(String.raw`${NUM}\s?(?:€|\$|£|euros?\b|eur\b|dollars?\b|usd\b|bucks\b|balles\b|pounds?\b)`, 'i'),
  new RegExp(String.raw`(?:budget|max(?:imum)?|up to|no more than|under|jusqu'?à|pas plus de|moins de)\s*(?:is|of|de|:|=)?\s*${NUM}`, 'i'),
];
const EACH = /^\s*(?:each|per (?:person|head|guest)|a head|pp\b|par (?:personne|tête|pers)|chacun|chacune|\/\s?pers)/i;
const PEOPLE = /(?:for|pour|of us|we are|on est|nous sommes)\s+(\d{1,2})\b|\b(\d{1,2})\s+(?:people|persons|pers\b|guests|friends|adults|personnes|amis|invités|adultes)/i;

function toNumber(raw, k) {
  let s = raw.replace(/[\s  ]/g, '');
  if (/^\d{1,3}([.,])\d{3}(\1\d{3})*$/.test(s)) s = s.replace(/[.,]/g, ''); // 1.500 / 1,500 -> 1500
  else s = s.replace(',', '.'); // 40,50 -> 40.5
  const n = Number(s) * (k ? 1000 : 1);
  return Number.isFinite(n) ? n : null;
}

// -> { amount, perPerson, people } or null
export function budgetFromText(text = '') {
  const t = String(text);
  for (const re of PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    let n = toNumber(m[1], m[2]);
    if (!n || n <= 0 || n >= 100000) continue;
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 24);
    let people = null;
    if (EACH.test(after)) {
      const p = t.match(PEOPLE);
      people = p ? Number(p[1] || p[2]) : null;
      if (people > 1 && people <= 40) n *= people;
    }
    return { amount: Math.round(n), perPerson: EACH.test(after), people };
  }
  return null;
}
