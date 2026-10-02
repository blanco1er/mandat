// The mandate envelope: the budget the user signs once, and every movement the agent makes inside it.
// Money states follow PayPal: an authorization HOLDS funds, a capture SPENDS them, a void or refund RELEASES them.
// The envelope is the single source of truth the agent must ask before any payment.

export function createEnvelope({ total, currency = 'EUR', approveAbove = null, purpose = '' }) {
  return {
    total: round(total),
    currency,
    purpose,
    // Payments above this amount need the user's explicit approval (null = every payment needs approval).
    approveAbove: approveAbove === null ? null : round(approveAbove),
    entries: [], // { id, merchant, label, amount, state: 'held'|'captured'|'released'|'refunded', paypal: {...}, at }
  };
}

export function totals(env) {
  let held = 0;
  let spent = 0;
  for (const e of env.entries) {
    if (e.state === 'held') held += e.amount;
    if (e.state === 'captured') spent += e.amount - (e.refunded || 0);
  }
  held = round(held);
  spent = round(spent);
  return { total: env.total, held, spent, remaining: round(env.total - held - spent), currency: env.currency };
}

// Can the agent commit `amount` right now? Returns { ok, reason, needsApproval }.
export function check(env, amount) {
  const t = totals(env);
  if (!(amount > 0)) return { ok: false, reason: 'Amount must be positive.' };
  if (amount > t.remaining + 1e-9) {
    return { ok: false, reason: `Over the mandate: ${fmt(amount, env)} asked, ${fmt(t.remaining, env)} left.` };
  }
  // approveAbove: null = autopilot (no tap needed inside the budget); 0 = ask before every payment.
  const needsApproval = env.approveAbove !== null && env.approveAbove !== undefined && amount > env.approveAbove;
  return { ok: true, needsApproval };
}

export function hold(env, { id, merchant, label, amount, paypal }) {
  const verdict = check(env, amount);
  if (!verdict.ok) throw new Error(verdict.reason);
  const entry = { id, merchant, label, amount: round(amount), state: 'held', paypal: paypal || {}, at: new Date().toISOString() };
  env.entries.push(entry);
  return entry;
}

export function capture(env, id, paypal = {}) {
  const e = find(env, id);
  if (e.state !== 'held') throw new Error(`Cannot capture ${id}: it is ${e.state}.`);
  e.state = 'captured';
  Object.assign(e.paypal, paypal);
  return e;
}

export function release(env, id, paypal = {}) {
  const e = find(env, id);
  if (e.state !== 'held') throw new Error(`Cannot release ${id}: it is ${e.state}.`);
  e.state = 'released';
  Object.assign(e.paypal, paypal);
  return e;
}

export function refund(env, id, amount, paypal = {}) {
  const e = find(env, id);
  if (e.state !== 'captured') throw new Error(`Cannot refund ${id}: it is ${e.state}.`);
  e.refunded = round((e.refunded || 0) + amount);
  if (e.refunded >= e.amount - 1e-9) e.state = 'refunded';
  Object.assign(e.paypal, paypal);
  return e;
}

function find(env, id) {
  const e = env.entries.find((x) => x.id === id);
  if (!e) throw new Error('Unknown payment ' + id);
  return e;
}

export function fmt(amount, env) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: env.currency }).format(amount);
}

function round(x) {
  return Math.round(Number(x) * 100) / 100;
}
