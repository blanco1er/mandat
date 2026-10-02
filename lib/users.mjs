// Users and missions, persisted as small JSON files (one per user, one per mission).
// A user signs the PayPal mandate once; each mission gets its own envelope inside the user's limits.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
};

export const getUser = (id) => (/^u_[0-9a-f]{16}$/.test(id || '') ? read(USERS, id) : null);
export const saveUser = (u) => write(USERS, u);
export const getMission = (id) => (/^s_[0-9a-f]{12}$/.test(id || '') ? read(MISSIONS, id) : null);
export const saveMission = (m) => write(MISSIONS, m);
export const deleteMission = (id) => /^s_[0-9a-f]{12}$/.test(id) && fs.rmSync(path.join(MISSIONS, id + '.json'), { force: true });

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
  if (p.people?.length) lines.push(`Their people (split bills go to these emails): ${p.people.map((x) => { const e = x.email || (/@/.test(x.contact || '') ? x.contact : ''); return x.name + (e ? ` <${e}>` : ''); }).join(', ')}`);
  return lines.join('\n');
}

// Sum of budgets of missions this calendar month (for the monthly cap).
export function monthCommitted(user, missions) {
  const month = new Date().toISOString().slice(0, 7);
  return missions.filter((m) => m && m.createdAt.slice(0, 7) === month).reduce((t, m) => t + m.envelope.total, 0);
}
