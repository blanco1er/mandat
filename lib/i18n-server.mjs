// Server-side words the user sees (notifications, a few lines in the conversation), in the app language.
// Gettext style, like public/i18n.js: tr(lang, 'English text', { vars }) gives the French text when lang is 'fr'.
const NNBSP = ' ';
const NBSP = ' ';

const FR = {
  // notifications
  'Approve {amount} at {merchant}? Tap to review.': `Approuver {amount} chez {merchant}${NNBSP}? Touchez pour vérifier.`,
  '{merchant} accepted your booking.': '{merchant} a accepté votre réservation.',
  '{merchant} accepted your booking for {slot}.': '{merchant} a accepté votre réservation pour {slot}.',
  "{merchant} can't take it. Mandat is looking for another option.": '{merchant} ne peut pas vous recevoir. Mandat cherche une autre option.',
  '{merchant} proposes {slot} instead. Does that work?': `{merchant} propose plutôt {slot}. Ça vous va${NNBSP}?`,
  '{merchant} confirmed your booking. {amount} deposit paid with PayPal.': '{merchant} a confirmé votre réservation. Acompte de {amount} payé avec PayPal.',
  '{date} at {time}': '{date} à {time}',
  '{n} reminder planned.': '{n} rappel prévu.',
  '{n} reminders planned.': '{n} rappels prévus.',
  'Tell me if you want to change anything.': 'Dites-moi si vous voulez changer quelque chose.',
  '{friend} paid their share: {amount}.': `{friend} a payé sa part${NNBSP}: {amount}.`,
  'Notifications are on. I will only ping you when something needs you.': 'Les notifications sont activées. Je ne vous préviens que lorsque c’est utile.',
  // conversation
  'Read your photo': 'Photo lue',
  'Read {n} photos': '{n} photos lues',
  "Couldn't read the photo right now. Tell me what it shows.": 'Impossible de lire la photo pour le moment. Dites-moi ce qu’elle montre.',
  "I've done what I can for now. Tell me how you'd like to continue.": 'J’ai fait ce que je pouvais pour l’instant. Dites-moi comment continuer.',
  'All set': 'Tout est prêt',
  'Everything is booked': 'Tout est réservé',
  'Above your daily limit of {cap} ({today} already today)': 'Au-delà de votre plafond quotidien de {cap} ({today} déjà aujourd’hui)',
  // reminders (also the calendar event title)
  'Tomorrow: {what}, {merchant} at {time}': `Demain${NNBSP}: {what}, {merchant} à {time}`,
  'Tomorrow: {what} at {time}': `Demain${NNBSP}: {what} à {time}`,
  'Time to go: {what} at {merchant}, {time}': `C’est l’heure${NNBSP}: {what} chez {merchant}, {time}`,
  'Time to go: {what}, {time}': `C’est l’heure${NNBSP}: {what}, {time}`,
  // clashes, as shown to the user
  '{what} ({when}) overlaps {other} ({otherWhen}).': '{what} ({when}) chevauche {other} ({otherWhen}).',
  '{what} ({when}) overlaps {other} ({otherWhen}, mission “{mission}”).': `{what} ({when}) chevauche {other} ({otherWhen}, mission «${NNBSP}{mission}${NNBSP}»).`,
  '{what} ({when}) is less than 30 minutes from {other} ({otherWhen}).': '{what} ({when}) est à moins de 30 minutes de {other} ({otherWhen}).',
  '{what} ({when}) is less than 30 minutes from {other} ({otherWhen}, mission “{mission}”).': `{what} ({when}) est à moins de 30 minutes de {other} ({otherWhen}, mission «${NNBSP}{mission}${NNBSP}»).`,
  'Two stays on the same night: {what} and {other}.': `Deux hébergements la même nuit${NNBSP}: {what} et {other}.`,
  'Two stays on the same night: {what} and {other} (mission “{mission}”).': `Deux hébergements la même nuit${NNBSP}: {what} et {other} (mission «${NNBSP}{mission}${NNBSP}»).`,
  '{what} ({when}) falls during {other}. You may be away.': '{what} ({when}) tombe pendant {other}. Vous serez peut-être absent.',
  '{what} ({when}) falls during {other} (mission “{mission}”). You may be away.': `{what} ({when}) tombe pendant {other} (mission «${NNBSP}{mission}${NNBSP}»). Vous serez peut-être absent.`,
  // calendar files
  'Mandat plan': 'Programme Mandat',
  '{title} · reminder from Mandat': '{title} · rappel de Mandat',
  'Nothing with a date in this plan yet.': 'Rien de daté dans ce programme pour l’instant.',
  'Unknown reminder': 'Rappel inconnu',
  // errors shown as they are
  'Mandat has reached its daily demo limit. Please come back tomorrow.': 'Mandat a atteint sa limite quotidienne de démo. Revenez demain.',
  "That's {n} new missions today, the demo limit. Continue an existing one, or come back tomorrow.": 'Déjà {n} nouvelles missions aujourd’hui, la limite de la démo. Continuez une mission existante ou revenez demain.',
  "You reached today's demo limit for the AI. It resets at midnight (UTC).": 'Vous avez atteint la limite quotidienne de l’IA pour la démo. Elle se réinitialise à minuit (UTC).',
  'Unknown mission': 'Mission inconnue',
  'Not your mission': 'Cette mission n’est pas la vôtre',
  'Write a short sentence.': 'Écrivez une courte phrase.',
  'Payment details and passwords never go into memory.': 'Les données de paiement et les mots de passe ne vont jamais en mémoire.',
  'Ask something': 'Posez une question',
  'Get to know me': 'Faire connaissance',
  'Give the mission a name.': 'Donnez un nom à la mission.',
  'Sign the PayPal mandate first.': 'Signez d’abord le mandat PayPal.',
  'Mandat is stopped. Resume it in Settings.': 'Mandat est à l’arrêt. Relancez-le dans les Réglages.',
  'Your monthly limit ({cap}) is already planned. Raise it in Settings, or say a budget.': 'Votre plafond mensuel ({cap}) est déjà engagé. Relevez-le dans les Réglages ou indiquez un budget.',
  'A mission budget goes from 1 to 5,000 €.': `Le budget d’une mission va de 1 à 5${NNBSP}000${NBSP}€.`,
  'This would exceed your monthly limit ({cap}, {used} already planned).': 'Cela dépasserait votre plafond mensuel ({cap}, dont {used} déjà engagés).',
  'Empty message': 'Message vide',
  'An image is too large (2.5 MB max).': `Une image est trop lourde (2,5${NBSP}Mo max).`,
  'Money is still held for this mission. Release it or archive the mission instead.': 'De l’argent est encore bloqué pour cette mission. Libérez-le ou archivez plutôt la mission.',
  'Type an address': 'Saisissez une adresse',
  'Choose accept, decline or counter': 'Choisissez accepter, refuser ou proposer',
  'Say which time you can do': 'Indiquez l’horaire qui vous convient',
  'Unknown request': 'Demande inconnue',
  'This request was already answered.': 'Cette demande a déjà reçu une réponse.',
  'No deposit is waiting to be collected.': 'Aucun acompte n’attend d’être encaissé.',
  'Nothing held to collect.': 'Aucun acompte bloqué à encaisser.',
  'This inbox link is not valid.': 'Ce lien de boîte de réception n’est pas valide.',
};

export const LANGS = ['en', 'fr'];
export const langOf = (x) => (x === 'fr' ? 'fr' : 'en');
const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m)) : s);
export function tr(lang, english, vars) {
  return fill((lang === 'fr' && FR[english]) || english, vars);
}
// Counts: trn(lang, n, '{n} reminder planned.', '{n} reminders planned.') (French: 0 and 1 are singular).
export function trn(lang, n, one, other, vars = {}) {
  const single = lang === 'fr' ? n < 2 : n === 1;
  return tr(lang, single ? one : other, { n, ...vars });
}
export const locale = (lang) => (lang === 'fr' ? 'fr-FR' : 'en-IE');
export const money = (lang, v, currency = 'EUR') => new Intl.NumberFormat(locale(lang), { style: 'currency', currency, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v || 0);
