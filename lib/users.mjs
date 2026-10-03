// Users and missions, persisted as small JSON files (one per user, one per mission).
// A user signs the PayPal mandate once; each mission gets its own envelope inside the user's limits.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { persist } from './store.mjs';

const DATA = path.resolve(process.env.MANDAT_DATA || 'data');
const USERS = path.join(DATA, 'users');
const MISSIONS = path.join(DATA, 'missions');
fs.mkdirSync(USERS, { recursive: true });
fs.mkdirSync(MISSIONS, { recursive: true });

export const AUTONOMY = {
  careful: { label: 'Careful', approveAbove: 0, help: 'Asks before every payment.' },
  balanced: { label: 'Balanced', approveAbove: 100, help: 'Pays small deposits alone, asks above your limit.' },
  autopilot: { label: 'Autopilot', approveAbove: null, help: 'Handles everything inside the mission budget and keeps you posted.' },
};

export function newUser() {
  return {
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    createdAt: new Date().toISOString(),
    profile: { name: '', email: '', phone: '', home: null, diet: '', preferences: '', people: [] },
    rules: { autonomy: 'balanced', approveAbove: 100, monthlyCap: 1500, dailyCap: 300 },
    voice: { on: true },
    paypal: { connected: false, payerName: '', payerEmail: '', verified: false, mandate: null },
    frozen: false,
    missions: [],
  };
}

const read = (dir, id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'));
  } catch {
    return null;
  }
};
const write = (dir, obj) => {
  const f = path.join(dir, obj.id + '.json');
  // Runtime-only fields start with '_' (e.g. the attached user) and are never written to disk.
  fs.writeFileSync(f + '.tmp', JSON.stringify(obj, (k, v) => (k.startsWith('_') ? undefined : v), 2));
  fs.renameSync(f + '.tmp', f);
  persist(f);
};

export const getUser = (id) => (/^u_[0-9a-f]{16}$/.test(id || '') ? read(USERS, id) : null);
// The account waiting for this PayPal approval (the approval may come back in another browser, e.g. Safari
// opened over the installed app, which has its own cookies).
export function userWithSetup(tokenId) {
  if (!tokenId) return null;
  for (const f of fs.readdirSync(USERS)) {
    const u = f.endsWith('.json') ? read(USERS, f.slice(0, -5)) : null;
    if (u?.pendingSetup === tokenId) return u;
  }
  return null;
}
export const saveUser = (u) => write(USERS, u);
export const getMission = (id) => (/^s_[0-9a-f]{12}$/.test(id || '') ? read(MISSIONS, id) : null);
export const saveMission = (m) => { if (!m._cancelled) write(MISSIONS, m); }; // a deleted mission is never written back
export const deleteMission = (id) => {
  if (!/^s_[0-9a-f]{12}$/.test(id)) return;
  fs.rmSync(path.join(MISSIONS, id + '.json'), { force: true });
  persist(path.join(MISSIONS, id + '.json'));
};

// The effective approval threshold for a user's autonomy level.
export function approveAboveFor(user) {
  const a = user.rules.autonomy;
  if (a === 'careful') return 0;
  if (a === 'autopilot') return null;
  return user.rules.approveAbove;
}

// What the agent is allowed to know about the user (shown verbatim in Settings → "What Mandat knows").
export function agentBrief(user) {
  const p = user.profile;
  const lines = [];
  if (p.name) lines.push(`Name for bookings: ${p.name}`);
  if (p.phone || p.email) lines.push(`Contact for merchants: ${[p.phone, p.email].filter(Boolean).join(', ')}`);
  if (p.home?.label) lines.push(`Home: ${p.home.label}`);
  if (p.diet) lines.push(`Diet / allergies (never book against these): ${p.diet}`);
  if (p.preferences) lines.push(`Preferences: ${p.preferences}`);
  const fit = (f) => [f?.age && `age ${f.age}`, f?.height && `${f.height} cm`, f?.top && `top ${f.top}`, f?.bottom && `trousers ${f.bottom}`, f?.shoes && `shoes EU ${f.shoes}`, f?.style && `style: ${f.style}`].filter(Boolean).join(', ');
  if (fit(p.fit)) lines.push(`Their sizes and style (use them when buying clothes or shoes for them): ${fit(p.fit)}`);
  if (p.people?.length) lines.push(`Their people:\n${p.people.map((x) => { const e = x.email || (/@/.test(x.contact || '') ? x.contact : ''); return `- ${x.name}${x.relation ? ` (${x.relation})` : ''}${e ? ` <${e}> (split bills go here)` : ''}${fit(x.fit) ? ` · ${fit(x.fit)}` : ''}`; }).join('\n')}`);
  return lines.join('\n');
}

// Sum of budgets of missions this calendar month (for the monthly cap).
export function monthCommitted(user, missions) {
  const month = new Date().toISOString().slice(0, 7);
  // What a mission really ties up: the money held or paid; plus, while a mission with a budget the user
  // gave is still open, the rest of that budget. A mission without a budget (only the daily cap), a finished
  // or an archived one counts for what it used, nothing more.
  const used = (m) => (m.envelope.entries || []).filter((e) => e.state === 'held' || e.state === 'captured').reduce((t, e) => t + e.amount, 0);
  return missions.filter((m) => m && m.createdAt.slice(0, 7) === month).reduce((t, m) => {
    const open = !m.archived && !m.closed && m.envelope.source !== 'limit';
    return t + (open ? Math.max(m.envelope.total, used(m)) : used(m));
  }, 0);
}
