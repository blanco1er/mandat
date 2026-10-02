// Interface language: the phone's language (French or English for now), or the one chosen in Settings.
// Static text uses data-i18n="key" (or data-i18n-placeholder / data-i18n-aria); code uses t('key', {vars}).

const DICT = {
  en: {
    'welcome.brand.demo': 'PayPal sandbox',
    'welcome.title': 'Say what you need.<br>Set what you’ll spend.',
    'welcome.lede': 'Mandat finds the place, negotiates, books and pays with PayPal — and never goes a cent over.',
    'welcome.cta': 'Continue with',
    'welcome.fine': 'Your card and password stay with PayPal. This demo uses the PayPal sandbox: no real money moves.',
    'story.ask': 'Dinner for 4 on Saturday, €160 max',
    'story.found': '3 restaurants compared',
    'story.foundSub': 'Lumière · Paris 11 · ★ 4.6',
    'story.deal': 'Negotiated −10% for the group',
    'story.dealSub': '€144 instead of €160',
    'story.hold': 'Deposit held with PayPal',
    'story.holdSub': 'Paid only when Lumière confirms',
    'story.done': 'All set · Sat 7:30 pm',
    'story.doneSub': 'Reminder Friday 8 pm · in your calendar',
    'story.budget': '{held} held of {total}',
  },
  fr: {
    'welcome.brand.demo': 'PayPal sandbox',
    'welcome.title': 'Dites ce qu’il vous faut.<br>Fixez ce que vous dépensez.',
    'welcome.lede': 'Mandat trouve, négocie, réserve et paie avec PayPal — sans jamais dépasser d’un centime.',
    'welcome.cta': 'Continuer avec',
    'welcome.fine': 'Votre carte et votre mot de passe restent chez PayPal. Cette démo utilise le bac à sable PayPal : aucun vrai paiement.',
    'story.ask': 'Dîner pour 4 samedi soir, 160 € max',
    'story.found': '3 restaurants comparés',
    'story.foundSub': 'Lumière · Paris 11e · ★ 4,6',
    'story.deal': 'Négocié −10 % pour le groupe',
    'story.dealSub': '144 € au lieu de 160 €',
    'story.hold': 'Acompte bloqué avec PayPal',
    'story.holdSub': 'Payé seulement quand Lumière confirme',
    'story.done': 'Tout est calé · sam. 19 h 30',
    'story.doneSub': 'Rappel vendredi 20 h · dans votre agenda',
    'story.budget': '{held} bloqués sur {total}',
  },
};

export const LANGS = { en: 'English', fr: 'Français' };
function pick() {
  try {
    const saved = localStorage.getItem('mandat_lang');
    if (saved && DICT[saved]) return saved;
  } catch {}
  const nav = (navigator.languages?.[0] || navigator.language || 'en').toLowerCase();
  return nav.startsWith('fr') ? 'fr' : 'en';
}
export let lang = pick();
export const locale = () => (lang === 'fr' ? 'fr-FR' : 'en-GB');
document.documentElement.lang = lang;

export function t(key, vars = {}) {
  const s = DICT[lang][key] ?? DICT.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}
export function setLang(l) {
  if (!DICT[l]) return;
  try { localStorage.setItem('mandat_lang', l); } catch {}
  location.reload();
}
// Fill every [data-i18n] element under root. Values may contain <br> only.
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.innerHTML = t(el.dataset.i18n).replace(/<(?!br>)/g, '&lt;');
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}
export function addStrings(table) {
  for (const l of Object.keys(table)) Object.assign(DICT[l] ||= {}, table[l]);
}
