#!/usr/bin/env node
// Rapport des visites de la démo hébergée, en français, pour le propriétaire seulement.
// Lit le journal anonyme (lib/visits.mjs) par GET /api/visits/export, avec le jeton secret rangé dans le trousseau
// macOS par scripts/visits-token.sh (ou la variable MANDAT_VISITS_TOKEN). Le jeton n'est jamais affiché.
//
//   node scripts/visits-report.mjs                    tout depuis le début
//   node scripts/visits-report.mjs --depuis 2026-10-20
//   node scripts/visits-report.mjs --detail           chaque session, pas à pas
//   node scripts/visits-report.mjs --session v_1a2b   une personne (début de son identifiant)
//   node scripts/visits-report.mjs --tout             y compris vos appareils (internes) et les robots
//   node scripts/visits-report.mjs --exclure v_1a2b,a_9f8e   écarter aussi ces identifiants
//   node scripts/visits-report.mjs --sauver visites.json     garder une copie brute sur le Mac
//   node scripts/visits-report.mjs --fichier data/visits     lire des fichiers .jsonl locaux au lieu du serveur
//   node scripts/visits-report.mjs --lien-interne     le lien secret qui exclut un appareil (à ouvrir une fois)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// ---- la démo de ce dépôt ----
const DEMO = { name: 'Mandat PayPal (PayPal AI Hackathon)', url: 'https://mandat-qb77.onrender.com', keychain: 'mandat-visits-paypal' };

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);
if (flag('--aide') || flag('--help')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const URL_BASE = (opt('--url') || process.env.MANDAT_VISITS_URL || DEMO.url).replace(/\/+$/, '');
const SINCE = opt('--depuis');
if (SINCE && !/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) { console.error('--depuis attend une date AAAA-MM-JJ'); process.exit(2); }
const TZ = 'Europe/Paris';

function token() {
  if (process.env.MANDAT_VISITS_TOKEN) return process.env.MANDAT_VISITS_TOKEN.trim();
  try {
    return execFileSync('security', ['find-generic-password', '-s', DEMO.keychain, '-a', 'mandat', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

async function load() {
  const dir = opt('--fichier');
  if (dir) {
    const files = fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map((f) => path.join(dir, f)) : [dir];
    const events = [];
    for (const f of files) {
      if (SINCE && path.basename(f).slice(0, 10) < SINCE) continue;
      if (f.endsWith('.json')) { events.push(...JSON.parse(fs.readFileSync(f, 'utf8')).events); continue; }
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l.trim()) { try { events.push(JSON.parse(l)); } catch {} }
    }
    return { storage: 'fichier local', events };
  }
  const t = token();
  if (!t) {
    console.error(`Jeton introuvable. Lancez d'abord : zsh scripts/visits-token.sh  (trousseau « ${DEMO.keychain} »)`);
    process.exit(1);
  }
  let res;
  try {
    res = await fetch(`${URL_BASE}/api/visits/export${SINCE ? `?since=${SINCE}` : ''}`, { headers: { Authorization: `Bearer ${t}`, 'X-Mandat-Internal': '1' }, signal: AbortSignal.timeout(120000) });
  } catch (e) {
    console.error(`Serveur injoignable (${URL_BASE}) : ${e.message}. Une démo gratuite endormie met jusqu'à 1 minute à se réveiller : relancez.`);
    process.exit(1);
  }
  if (res.status === 404) {
    console.error('Le serveur refuse le jeton (404). Vérifiez que MANDAT_VISITS_TOKEN est posé dans Render, identique au trousseau, et que la version avec le suivi est déployée.');
    process.exit(1);
  }
  if (!res.ok) { console.error(`Erreur du serveur : HTTP ${res.status}`); process.exit(1); }
  return res.json();
}

if (flag('--lien-interne')) {
  const t = token();
  if (t.length < 32) { console.error('Jeton absent ou trop court : lancez zsh scripts/visits-token.sh'); process.exit(1); }
  const k = crypto.createHmac('sha256', t).update('internal-link').digest('hex').slice(0, 40);
  console.log(`Ouvrez ce lien une fois sur chacun de vos appareils et navigateurs (ne le partagez pas) :\n${URL_BASE}/api/visits/internal?k=${k}`);
  process.exit(0);
}

const data = await load();
if (opt('--sauver')) {
  fs.writeFileSync(opt('--sauver'), JSON.stringify(data, null, 1), { mode: 0o600 });
  console.log(`Copie brute enregistrée : ${opt('--sauver')}`);
}
const all = (data.events || []).filter((e) => e && e.t && e.e && (!SINCE || dayOf(e.t) >= SINCE)).sort((a, b) => a.t.localeCompare(b.t));

// ---------- personnes : un visiteur (adresse + navigateur) relié à son compte de démo ----------
const parent = new Map();
const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
const union = (a, b) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
for (const e of all) { if (e.v) add(e.v); if (e.a) add(e.a); if (e.v && e.a) union(e.v, e.a); }
const who = (e) => find(e.v || e.a || 'inconnu');
add('inconnu');
const groups = new Map();
for (const e of all) { const k = who(e); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
const exclude = new Set((opt('--exclure') || '').split(',').map((s) => s.trim()).filter(Boolean));
const people = [];
let internal = 0, bots = 0;
for (const [k, evs] of groups) {
  const ids = new Set(evs.flatMap((e) => [e.v, e.a]).filter(Boolean));
  const isInt = evs.some((e) => e.int) || [...ids].some((id) => [...exclude].some((x) => id.startsWith(x)));
  const isBot = evs.every((e) => e.bot);
  if (!flag('--tout') && isInt) { internal++; continue; }
  if (!flag('--tout') && isBot) { bots++; continue; }
  people.push({ key: k, ids: [...ids], events: evs, internal: isInt, bot: isBot });
}
const events = people.flatMap((p) => p.events.map((e) => ({ ...e, _p: p }))).sort((a, b) => a.t.localeCompare(b.t));

// ---------- formats ----------
function dayOf(t) { return new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)); }
const when = (t) => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
const hour = (t) => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(t));
const dur = (ms) => { const s = Math.round(ms / 1000); if (s < 60) return `${s} s`; const m = Math.floor(s / 60); return m < 60 ? `${m} min ${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
const short = (p) => p.ids.find((x) => x.startsWith('v_'))?.slice(0, 8) || p.ids[0]?.slice(0, 8) || '?';
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const title = (s) => console.log(`\n${s}\n${'─'.repeat(Math.min(60, s.length))}`);
const count = (list) => { const m = new Map(); for (const x of list) m.set(x, (m.get(x) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
const DEV = { mobile: 'téléphone', desktop: 'ordinateur', tablet: 'tablette' };
const BUDGETFR = { pill: 'choisi', words: 'dit dans la phrase', suggested: 'suggéré', limit: 'plafond du jour' };
const PAYFR = { authorized: 'autorisé (bloqué)', captured: 'capturé (payé)', voided: 'annulé (libéré)', refunded: 'remboursé' };
function label(e) {
  switch (e.e) {
    case 'page': return `page ${e.path}${e.ref && e.ref !== 'self' ? ` (venu de ${e.ref}${e.src ? `, ref=${e.src}` : ''})` : ''}`;
    case 'account_new': return 'compte de démo créé';
    case 'account_switch': return `changement de compte (${e.to === 'new' ? 'nouveau' : 'précédent'})`;
    case 'paypal_start': return 'clic « Continuer avec PayPal »';
    case 'paypal_signed': return `connexion PayPal sandbox réussie, mandat signé${e.mode && e.mode !== 'sandbox' ? ` (${e.mode})` : ''}`;
    case 'mandate_revoked': return 'mandat révoqué';
    case 'mission_new': return `MISSION « ${e.text || ''} »${e.budget ? ` [budget ${BUDGETFR[e.budget] || e.budget}]` : ''}${e.voice ? ' [voix]' : ''}${e.images ? ` [${e.images} photo(s)]` : ''}`;
    case 'turn': return `message « ${e.text || ''} »${e.voice ? ' [voix]' : ''}${e.images ? ` [${e.images} photo(s)]` : ''}`;
    case 'agent_run': return `tour de l'agent : ${dur(e.ms || 0)}, ${e.tools || 0} outil(s)${e.error ? ', ÉCHEC' : ''}`;
    case 'tool': return `outil ${e.name}`;
    case 'plan': return `plan affiché (${e.items} étape(s))`;
    case 'approval_shown': return `carte d'approbation affichée${e.amount ? ` : ${e.amount} ${e.cur || ''}` : ''}`;
    case 'approval_answer': return e.approved ? 'paiement APPROUVÉ' : 'paiement refusé';
    case 'payment': return `paiement de test ${PAYFR[e.state] || e.state}${e.amount ? ` : ${e.amount} ${e.cur || ''}` : ''}`;
    case 'mission_deleted': return 'mission supprimée';
    case 'interview': return '« Faire connaissance » (une réponse)';
    case 'ledger_ask': return 'question au registre des paiements';
    case 'leave': return `quitte la page (ouverte ${dur(e.ms || 0)})`;
    case 'error': return `ERREUR ${e.status || ''} ${e.where || ''} : ${e.msg || ''}`;
    case 'client_error': return `ERREUR dans le navigateur : ${e.msg || ''}${e.src ? ` (${e.src})` : ''}`;
    default: return e.e;
  }
}

// ---------- sessions : les événements d'une personne, coupés après 30 min sans rien ----------
const GAP = 30 * 60e3;
for (const p of people) {
  p.sessions = [];
  let cur = null;
  for (const e of p.events) {
    const t = Date.parse(e.t);
    if (!cur || t - cur.end > GAP) { cur = { start: t, end: t, events: [] }; p.sessions.push(cur); }
    cur.end = t;
    cur.events.push(e);
  }
  const page = p.events.find((e) => e.e === 'page' && e.ref && e.ref !== 'self');
  p.ref = page ? page.ref + (page.src ? ` (ref=${page.src})` : '') : p.events.some((e) => e.e === 'page') ? 'direct' : 'inconnu';
  const d = p.events.find((e) => e.dev) || {};
  p.dev = d.dev; p.os = d.os; p.br = d.br;
  const has = (f) => p.events.some(f);
  p.stage = has((e) => e.e === 'payment' && (e.state === 'authorized' || e.state === 'captured')) ? 7
    : has((e) => e.e === 'approval_answer' && e.approved) ? 6
      : has((e) => e.e === 'approval_shown') ? 5
        : has((e) => e.e === 'plan') ? 4
          : has((e) => e.e === 'mission_new') ? 3
            : has((e) => e.e === 'paypal_signed') ? 2
              : has((e) => e.e === 'account_new' || e.e === 'paypal_start') ? 1 : 0;
}
const STAGES = ['a ouvert la page', 'compte de démo créé', 'connecté à PayPal sandbox (mandat signé)', 'a lancé une mission', "a vu le plan de l'agent", "a vu une carte d'approbation", 'a approuvé un paiement', 'paiement de test réalisé'];

// ---------- rapport ----------
const first = all[0]?.t, last = all[all.length - 1]?.t;
console.log(`Visites — ${DEMO.name}`);
console.log(`Source : ${opt('--fichier') ? opt('--fichier') : URL_BASE} · stockage ${data.storage || '?'}${data.deleteAfter ? ` · effacement prévu après le ${data.deleteAfter}` : ''}`);
console.log(`Période : ${first ? `${when(first)} → ${when(last)} (heure de Paris)` : 'aucun événement'}${SINCE ? ` · depuis le ${SINCE}` : ''}`);
console.log(`Écartés : ${internal} personne(s) interne(s) (vous, vos scripts) · ${bots} robot(s)${flag('--tout') ? ' — option --tout : tout est affiché' : ''}`);

const sel = opt('--session');
if (sel) {
  const p = people.find((x) => x.ids.some((id) => id.startsWith(sel)));
  if (!p) { console.log(`\nAucune personne dont un identifiant commence par « ${sel} ».`); process.exit(0); }
  printPerson(p);
  process.exit(0);
}

const n = (f) => events.filter(f).length;
const distinct = (f, key = 'mid') => new Set(events.filter(f).map((e) => e[key])).size;
title('En bref');
console.log(`Personnes uniques : ${people.length}   Sessions : ${people.reduce((t, p) => t + p.sessions.length, 0)}`);
console.log(`Comptes de démo créés : ${n((e) => e.e === 'account_new')}   Connexions PayPal sandbox : ${n((e) => e.e === 'paypal_signed')}`);
console.log(`Missions : ${n((e) => e.e === 'mission_new')}   Messages : ${n((e) => e.e === 'turn')}   Tours de l'agent : ${n((e) => e.e === 'agent_run')}`);
console.log(`Plans : ${distinct((e) => e.e === 'plan')}   Cartes d'approbation : ${n((e) => e.e === 'approval_shown')} (approuvées ${n((e) => e.e === 'approval_answer' && e.approved)})`);
console.log(`Paiements de test : ${count(events.filter((e) => e.e === 'payment').map((e) => PAYFR[e.state] || e.state)).map(([k, v]) => `${v} ${k}`).join(', ') || 'aucun'}`);
console.log(`Erreurs : ${n((e) => e.e === 'error' || e.e === 'client_error')}`);

title('Par jour (heure de Paris)');
console.log(`${pad('Jour', 12)}${lpad('Personnes', 10)}${lpad('Comptes', 9)}${lpad('PayPal', 8)}${lpad('Missions', 10)}${lpad('Messages', 10)}`);
const days = [...new Set(events.map((e) => dayOf(e.t)))].sort();
for (const d of days) {
  const evd = events.filter((e) => dayOf(e.t) === d);
  const c = (t) => evd.filter((e) => e.e === t).length;
  console.log(`${pad(d, 12)}${lpad(new Set(evd.map((e) => e._p.key)).size, 10)}${lpad(c('account_new'), 9)}${lpad(c('paypal_signed'), 8)}${lpad(c('mission_new'), 10)}${lpad(c('turn'), 10)}`);
}

title('Provenance (premier site de chaque personne)');
for (const [k, v] of count(people.map((p) => p.ref))) console.log(`${lpad(v, 4)}  ${k}`);

title('Appareils');
console.log(count(people.map((p) => DEV[p.dev] || 'inconnu')).map(([k, v]) => `${v} ${k}`).join(' · '));
console.log(count(people.map((p) => p.os || '?')).map(([k, v]) => `${v} ${k}`).join(' · '));
console.log(count(people.map((p) => p.br || '?')).map(([k, v]) => `${v} ${k}`).join(' · '));

title("Jusqu'où ils sont allés");
for (let i = 0; i < STAGES.length; i++) {
  const k = people.filter((p) => p.stage >= i).length;
  console.log(`${lpad(k, 4)}  ${STAGES[i]}${i ? `  (${people.length ? Math.round((100 * k) / people.length) : 0} %)` : ''}`);
}

title('Phrases demandées');
const asked = events.filter((e) => e.e === 'mission_new' || e.e === 'turn');
if (!asked.length) console.log('Aucune.');
for (const e of asked) console.log(`${when(e.t)}  ${short(e._p)}  ${e.e === 'mission_new' ? 'MISSION' : 'message'}  « ${e.text || ''} »`);

title('Durée des sessions');
const durs = people.flatMap((p) => p.sessions.map((s) => s.end - s.start)).sort((a, b) => a - b);
if (durs.length) {
  const med = durs[Math.floor(durs.length / 2)], avg = durs.reduce((a, b) => a + b, 0) / durs.length;
  console.log(`Médiane ${dur(med)} · moyenne ${dur(avg)} · la plus longue ${dur(durs[durs.length - 1])} · ${durs.filter((d) => d < 10000).length} session(s) de moins de 10 s`);
} else console.log('Aucune.');

const tools = count(events.filter((e) => e.e === 'tool').map((e) => e.name));
if (tools.length) { title("Outils de l'agent les plus appelés"); console.log(tools.slice(0, 15).map(([k, v]) => `${k} ×${v}`).join(' · ')); }

title('Erreurs vues');
const errs = count(events.filter((e) => e.e === 'error' || e.e === 'client_error').map((e) => `${e.e === 'client_error' ? '[navigateur] ' : `[${e.status || ''} ${e.where || ''}] `}${e.msg || ''}`));
if (!errs.length) console.log('Aucune.');
for (const [k, v] of errs) console.log(`${lpad(v, 4)}×  ${k}`);

title('Personnes (plus avancées en premier)');
for (const p of [...people].sort((a, b) => b.stage - a.stage || a.events[0].t.localeCompare(b.events[0].t))) {
  const total = p.sessions.reduce((t, s) => t + s.end - s.start, 0);
  console.log(`${short(p)}  ${when(p.events[0].t)}  ${pad(p.ref, 22)} ${pad(`${DEV[p.dev] || '?'} ${p.os || ''} ${p.br || ''}`, 30)} ${p.sessions.length} session(s), ${dur(total)} → ${STAGES[p.stage]}${p.internal ? ' [interne]' : ''}${p.bot ? ' [robot]' : ''}`);
}
console.log(`\nDétail d'une personne : node scripts/visits-report.mjs --session <identifiant>   ·   tout : --detail`);
if (flag('--detail')) for (const p of people) printPerson(p);

function printPerson(p) {
  title(`Personne ${short(p)} — ${p.ref} — ${DEV[p.dev] || '?'} ${p.os || ''} ${p.br || ''}`);
  console.log(`Identifiants : ${p.ids.join(', ')}`);
  p.sessions.forEach((s, i) => {
    console.log(`\n  Session ${i + 1} : ${when(s.start)}, durée ${dur(s.end - s.start)}`);
    for (const e of s.events) console.log(`    ${hour(e.t)}  ${label(e)}`);
  });
}
