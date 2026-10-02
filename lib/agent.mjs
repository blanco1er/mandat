// The Mandat agent: one conversation, one budget envelope, tools that really search, negotiate and pay.
// Every step is emitted as an event so the interface (and the demo video) can show the agent working live.
import crypto from 'node:crypto';
import { chat, MODELS } from './deepseek.mjs';
import * as Env from './envelope.mjs';
import * as PayPal from './paypal.mjs';
import { shareInvoice } from './invoices.mjs';
import { splitBill } from './split.mjs';
import { MERCHANTS, merchant, identityCard, verifyCard, askMerchantAgent, inboxUrl } from './merchants.mjs';
import { nearby, geocode } from './places.mjs';
import { agentBrief, approveAboveFor, getMission } from './users.mjs';

const MAX_STEPS = 14;

const TOOLS = [
  fn('find_real_places', 'Search real places around the user with OpenStreetMap (names, distance, opening hours). Use it to ground the plan in reality.', {
    category: { type: 'string', enum: ['restaurant', 'bar', 'cafe', 'bakery', 'florist', 'hotel', 'hairdresser', 'cinema'] },
    near: { type: 'string', description: 'Address or neighbourhood; omit to use the user location.' },
  }, ['category']),
  fn('find_network_merchants', 'List merchants of the Mandat network that can be booked and paid through PayPal (some run their own AI agent, some do not).', {
    category: { type: 'string', enum: ['restaurant', 'bakery', 'florist', 'hotel'] },
  }, ['category']),
  fn('verify_merchant', "Verify a merchant's signed identity card before negotiating or paying (Know Your Agent).", { merchant_id: { type: 'string' } }, ['merchant_id']),
  fn('negotiate', "Send one message to a merchant's AI agent and get its reply and structured offer. Only for merchants with hasAgent=true.", {
    merchant_id: { type: 'string' },
    message: { type: 'string', description: 'What you ask or counter-offer, as the buyer agent.' },
  }, ['merchant_id', 'message']),
  fn('request_booking', 'For merchants WITHOUT an AI agent: send a booking request they accept with one tap. The deposit is only held after they accept.', {
    merchant_id: { type: 'string' },
    items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'number' } }, required: ['sku', 'qty'] } },
    slot: { type: 'string' },
    note: { type: 'string' },
  }, ['merchant_id', 'items']),
  fn('hold_deposit', 'Hold (authorize) a deposit with PayPal for an agreed offer. Checked against the mandate; may require the user approval first.', {
    merchant_id: { type: 'string' },
    amount: { type: 'number' },
    label: { type: 'string' },
    offer_total: { type: 'number' },
  }, ['merchant_id', 'amount', 'label']),
  fn('cancel_hold', 'Release a held deposit (void the PayPal authorization) when the plan changes, before the merchant has confirmed.', { payment_id: { type: 'string' } }, ['payment_id']),
  fn('refund_payment', "Refund a deposit that was already paid (captured), fully or partly — e.g. the booking was cancelled within the merchant's free-cancellation window, or the merchant could not deliver. The money goes back to the user's PayPal and into the mission budget.", {
    payment_id: { type: 'string' },
    amount: { type: 'number', description: 'Omit for a full refund.' },
    reason: { type: 'string' },
  }, ['payment_id', 'reason']),
  fn('split_bill', "Split a cost the user paid with friends. Each friend gets a real, detailed PayPal invoice (the bill's lines, who paid, how it was split, their share) with a pay link and a QR code; PayPal also emails it when you know their address. Pass the bill's lines, place and date whenever you know them. Equal split by default; give amounts only for unequal shares.", {
    total: { type: 'number', description: 'Total amount of the bill, user included.' },
    label: { type: 'string', description: 'What it was for, e.g. "Tapas dinner".' },
    where: { type: 'string', description: 'Place or merchant, if known.' },
    date: { type: 'string', description: 'YYYY-MM-DD, if known.' },
    items: { type: 'array', description: "The bill's lines, if known.", items: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'number' } }, required: ['name', 'amount'] } },
    my_amount: { type: 'number', description: "Only for an unequal split: the user's own part." },
    friends: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string', description: 'Optional. Only if the user gave it.' }, amount: { type: 'number', description: 'Only for an unequal split.' } }, required: ['name'] } },
  }, ['total', 'label', 'friends']),
  fn('update_plan', 'Publish the current plan the user sees (one line per booking).', {
    items: { type: 'array', items: { type: 'object', properties: { what: { type: 'string' }, merchant: { type: 'string' }, when: { type: 'string' }, total: { type: 'number' }, status: { type: 'string', enum: ['searching', 'negotiating', 'requested', 'awaiting_approval', 'held', 'confirmed', 'cancelled'] } }, required: ['what', 'status'] } },
  }, ['items']),
];

function fn(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

export function createSession({ budget, currency = 'EUR', approveAbove = 50, purpose = '', location = null, language = 'en', userId = null, title = '', emoji = '✦' }) {
  return {
    id: 's_' + crypto.randomBytes(6).toString('hex'),
    createdAt: new Date().toISOString(),
    userId,
    title: title || purpose.slice(0, 48),
    emoji,
    frozen: false,
    envelope: Env.createEnvelope({ total: budget, currency, approveAbove, purpose }),
    mandate: null, // { paymentTokenId, mode }
    location, // { lat, lon, label }
    language,
    messages: [],
    threads: {}, // merchant_id -> negotiation thread (for the merchant agent)
    transcripts: {}, // merchant_id -> [{ from, text, offer }]
    requests: {}, // request_id -> booking request to a merchant without agent
    approvals: {}, // approval_id -> pending payment awaiting the user
    plan: [],
    shares: [],
  };
}

// Stable instructions first and the changing budget state last: DeepSeek bills a repeated prefix
// (cache hit) about ten times cheaper, so nothing that changes during a mission belongs up here.
function systemPrompt(s) {
  const t = Env.totals(s.envelope);
  const brief = s._user ? agentBrief(s._user) : '';
  const autonomy = s._user?.rules?.autonomy || 'balanced';
  return `You are Mandat, a personal agent that the user trusts with a budget. You talk with the user by voice: keep every reply short (1–3 sentences), warm, natural, no lists, no markdown. Reply in the user's language.
Mandate: ${Env.fmt(t.total, s.envelope)} total for "${s.envelope.purpose || 'the user request'}" (the live remaining amount is given in the last message). ${s.envelope.approveAbove === null ? 'Autopilot: you may hold deposits without asking, inside the mandate (the daily limit still applies).' : `Payments above ${Env.fmt(s.envelope.approveAbove, s.envelope)} need the user's tap to approve.`}
User location: ${s.location ? s.location.label : s._user?.profile?.home?.label ? 'home: ' + s._user.profile.home.label : 'unknown (ask if needed)'}.
Autonomy level chosen by the user: ${autonomy}${autonomy === 'autopilot' ? ' — act without asking, inside the mission budget, and report each step briefly' : ''}.
${brief ? 'What you know about the user (use it, never ask again):\n' + brief : ''}
How you work:
- Ask at most 2 short clarifying questions when something essential is missing (people, date/time, preferences), then act.
- Ground choices in reality with find_real_places, then book through the Mandat network (find_network_merchants).
- Always verify_merchant before negotiating or paying.
- Merchants with an AI agent: negotiate (ask for availability and a better price, counter once if useful). Merchants without one: request_booking.
- Never exceed the mandate. Prefer deposits (holds) over full payments; nothing is captured until the service is confirmed.
- Keep the plan visible with update_plan after each important step.
- If the user mentions friends, offer to split_bill.
- Be honest: these are demo merchants and PayPal sandbox payments.`;
}

// Run one user turn. `emit(type, data)` streams events to the interface.
export async function userTurn(s, text, emit, { image } = {}) {
  if (image) {
    // Read the photo once with the vision model, then keep a precise text description in the conversation.
    const seen = await describeImage(image, text);
    emit('photo_read', { summary: seen });
    text = `${text || 'Here is a photo.'}\n[Photo the user sent — what it shows: ${seen}]`;
  }
  s.messages.push({ role: 'user', content: text });
  for (let step = 0; step < MAX_STEPS; step++) {
    const live = { role: 'system', content: `Live state — today is ${new Date().toISOString().slice(0, 10)}; remaining in the mandate: ${Env.fmt(Env.totals(s.envelope).remaining, s.envelope)}.` };
    const { message } = await chat({
      model: MODELS.fast, fallback: MODELS.smart, temperature: 0.4, maxTokens: 4000, tools: TOOLS,
      messages: [{ role: 'system', content: systemPrompt(s) }, ...s.messages, live],
      onDelta: (t) => emit('say_delta', { t }), // the reply appears word by word on screen
      onReset: () => emit('say_reset', {}),
    });
    const calls = message.tool_calls || [];
    s.messages.push({ role: 'assistant', content: message.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
    if (message.content?.trim()) emit('say', { text: message.content.trim() });
    if (!calls.length) return;
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {}
      emit('tool', { name: call.function.name, args });
      let result;
      try {
        result = await runTool(s, call.function.name, args, emit);
      } catch (e) {
        result = { error: e.message };
      }
      s.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  emit('say', { text: "I've done what I can for now — tell me how you'd like to continue." });
}

async function runTool(s, name, a, emit) {
  switch (name) {
    case 'find_real_places': {
      let center = s.location;
      if (a.near) center = await withTimeout(geocode(a.near), 6000).catch(() => center);
      if (!center) return { error: 'No location yet. Ask the user where.' };
      const places = await withTimeout(nearby({ lat: center.lat, lon: center.lon, category: a.category, limit: 5 }), 7000).catch(() => []);
      emit('places', { category: a.category, center, places });
      return { near: center.label, places: places.map(({ name, distance, openingHours, cuisine }) => ({ name, distance_m: distance, openingHours, cuisine })) };
    }
    case 'find_network_merchants': {
      const list = MERCHANTS.filter((m) => m.category === a.category).map(({ rules, ...pub }) => pub);
      emit('merchants', { category: a.category, merchants: list });
      return { merchants: list };
    }
    case 'verify_merchant': {
      const m = merchant(a.merchant_id);
      const card = identityCard(m);
      const ok = verifyCard(card);
      emit('verified', { merchant_id: m.id, name: m.name, ok, card });
      return { verified: ok, agent: card.agent, issuedBy: card.issuedBy };
    }
    case 'negotiate': {
      const m = merchant(a.merchant_id);
      if (!m.hasAgent) return { error: `${m.name} has no AI agent. Use request_booking.` };
      const thread = (s.threads[m.id] ||= []);
      const tr = (s.transcripts[m.id] ||= []);
      tr.push({ from: 'mandat', text: a.message });
      emit('negotiation', { merchant_id: m.id, name: m.name, from: 'mandat', text: a.message });
      const r = await askMerchantAgent(m.id, thread, a.message);
      tr.push({ from: 'merchant', text: r.reply, offer: r.offer });
      emit('negotiation', { merchant_id: m.id, name: m.name, from: 'merchant', text: r.reply, offer: r.offer });
      return r;
    }
    case 'request_booking': {
      const m = merchant(a.merchant_id);
      // Never swap in another product, and never send a request the mandate cannot pay.
      const unknown = (a.items || []).filter((it) => !m.offers.some((x) => x.sku === it.sku));
      if (!a.items?.length || unknown.length) return { error: `${m.name} does not sell that. What they offer: ${m.offers.map((o) => `${o.sku} (${o.label}, ${o.price} €)`).join('; ')}. Tell the user honestly and look elsewhere if it does not fit.` };
      const items = a.items.map((it) => {
        const o = m.offers.find((x) => x.sku === it.sku);
        return { sku: o.sku, label: o.label, qty: it.qty || 1, unit_price: o.price };
      });
      const total = round(items.reduce((t, it) => t + it.qty * it.unit_price, 0));
      const left = Env.totals(s.envelope).remaining;
      if (total > left) return { error: `This would cost ${Env.fmt(total, s.envelope)}, more than the ${Env.fmt(left, s.envelope)} left in the mandate. Request not sent.` };
      const id = 'r_' + crypto.randomBytes(4).toString('hex');
      const customer = s._user?.profile?.name || s._user?.paypal?.payerName || 'A Mandat customer';
      const req = { id, sessionId: s.id, merchant_id: m.id, merchant: m.name, items, total, deposit: round(total * m.deposit), slot: a.slot || '', note: a.note || '', customer, status: 'pending', inbox: inboxUrl(m.id), createdAt: new Date().toISOString() };
      s.requests[id] = req;
      emit('request', req);
      return { request_id: id, status: 'pending', total, deposit: req.deposit, info: 'The merchant will accept with one tap; you will be told. Continue with other bookings meanwhile.' };
    }
    case 'hold_deposit': {
      const m = merchant(a.merchant_id);
      if (s._user) s.envelope.approveAbove = approveAboveFor(s._user); // autonomy changes apply immediately
      const verdict = Env.check(s.envelope, a.amount);
      if (!verdict.ok) return { error: verdict.reason };
      const today = spentToday(s);
      const cap = s._user?.rules?.dailyCap;
      const overDaily = cap > 0 && today + a.amount > cap;
      if (verdict.needsApproval || overDaily) {
        const id = 'a_' + crypto.randomBytes(4).toString('hex');
        s.approvals[id] = { id, merchant_id: m.id, merchant: m.name, amount: round(a.amount), label: a.label, offer_total: a.offer_total, status: 'pending', ...(overDaily ? { reason: `Above your daily limit of ${Env.fmt(cap, s.envelope)} (${Env.fmt(today, s.envelope)} already today)` } : {}) };
        emit('approval', s.approvals[id]);
        return { status: 'awaiting_user_approval', approval_id: id, info: 'Ask the user to approve on screen; do not wait in silence.' };
      }
      return await doHold(s, { merchant: m, amount: a.amount, label: a.label }, emit);
    }
    case 'refund_payment': {
      const e = s.envelope.entries.find((x) => x.id === a.payment_id);
      if (!e) return { error: 'Unknown payment' };
      if (e.state !== 'captured') return { error: e.state === 'held' ? 'Not paid yet: use cancel_hold to release it.' : `Nothing to refund: it is ${e.state}.` };
      const left = round(e.amount - (e.refunded || 0));
      const amount = round(Math.min(a.amount > 0 ? a.amount : left, left));
      const r = await PayPal.refund({ captureId: e.paypal.captureId, amount, currency: s.envelope.currency, note: a.reason });
      Env.refund(s.envelope, e.id, amount, { refundId: r.refundId, refundStatus: r.status });
      emit('payment', { kind: 'refund', entry: { ...e, amount }, mode: r.mode, reason: a.reason });
      emit('envelope', envelopeView(s));
      return { refunded: amount, status: r.status, remaining: Env.totals(s.envelope).remaining };
    }
    case 'cancel_hold': {
      const e = s.envelope.entries.find((x) => x.id === a.payment_id);
      if (!e) return { error: 'Unknown payment' };
      if (e.state !== 'held') return { error: `It is ${e.state}, not held${e.state === 'captured' ? ': use refund_payment' : ''}.` };
      const r = await PayPal.release({ authorizationId: e.paypal.authorizationId });
      Env.release(s.envelope, e.id, { voidStatus: r.status });
      emit('envelope', envelopeView(s));
      return { released: true, remaining: Env.totals(s.envelope).remaining };
    }
    case 'split_bill': {
      const friends = (a.friends || []).map((f) => (typeof f === 'string' ? { name: f } : f)).filter((f) => f?.name);
      if (!friends.length || !(a.total > 0)) return { error: 'Give the total and at least one friend.' };
      const from = s._user?.profile?.name?.split(' ')[0] || s._user?.paypal?.payerName?.split(' ')[0] || 'A friend';
      let split;
      try {
        split = splitBill({ total: a.total, items: a.items, people: [{ name: from, payer: true, amount: a.my_amount }, ...friends.map((f) => ({ name: f.name, amount: f.amount }))] });
      } catch (e) {
        return { error: e.message };
      }
      const per = split.people[1]?.amount;
      const known = Object.fromEntries((s._user?.profile?.people || []).filter((p) => p.email).map((p) => [p.name.toLowerCase(), p.email]));
      const links = await Promise.all(friends.map(async (f) => {
        const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email || '') ? f.email : known[f.name.toLowerCase()] || null;
        try {
          const person = split.people.find((p) => p.name === f.name);
          const r = await shareInvoice({ person, split, email, currency: s.envelope.currency, label: a.label, from, where: a.where, date: a.date, appUrl: publicUrl() });
          return { friend: f.name, email, amount: person.amount, ...r };
        } catch (e) {
          return { friend: f.name, amount: split.people.find((p) => p.name === f.name)?.amount, error: e.message.slice(0, 160) };
        }
      }));
      const at = new Date().toISOString();
      s.shares.push(...links.map((l) => ({ ...l, label: a.label, at })));
      const breakdown = { total: split.total, equal: split.equal, rounding: split.rounding, where: a.where || '', date: a.date || '', people: split.people.map(({ name, amount, payer }) => ({ name, amount, payer })), items: split.people[0].lines.filter((l) => l.name).map(({ name, total }) => ({ name, total })) };
      emit('shares', { label: a.label, per, links, breakdown });
      return { shares: split.people.map(({ name, amount }) => ({ name, amount })), invoices: links.map((l) => ({ friend: l.friend, emailed: !!l.emailed, ok: !l.error, ...(l.error ? { error: l.error } : {}) })), info: 'Each friend can pay from the email, the link or the QR code on screen; you will see when they pay.' };
    }
    case 'update_plan': {
      s.plan = a.items || [];
      emit('plan', { items: s.plan });
      return { ok: true };
    }
    default:
      return { error: 'Unknown tool ' + name };
  }
}

// Hold a deposit for real (PayPal authorization through the vaulted mandate) and book it in the envelope.
export async function doHold(s, { merchant: m, amount, label }, emit) {
  if (s.frozen || s._user?.frozen) return { error: 'The user has stopped the agent. Do not pay; tell them the plan is paused.' };
  const mandate = s._user?.paypal?.mandate || s.mandate;
  if (!mandate) return { error: 'The user has not signed the PayPal mandate yet.' };
  const ref = 'p_' + crypto.randomBytes(4).toString('hex');
  const pp = await PayPal.hold({ paymentTokenId: mandate.paymentTokenId, amount, currency: s.envelope.currency, merchant: m.name, description: label, reference: ref });
  const entry = Env.hold(s.envelope, { id: ref, merchant: m.name, label, amount, paypal: pp });
  emit('payment', { kind: 'hold', entry, mode: pp.mode });
  // A merchant without an AI: the deposit waits for them to confirm from their inbox.
  const req = Object.values(s.requests || {}).find((r) => r.merchant_id === m.id && r.status === 'accepted' && !r.paymentId);
  if (req) req.paymentId = entry.id;
  // A merchant with its own agent confirms the booking on the spot: the deposit is paid now.
  if (m.hasAgent) {
    const c = await captureEntry(s, entry.id, emit, `${m.name}'s agent confirmed the booking`);
    emit('envelope', envelopeView(s));
    return { payment_id: entry.id, status: 'paid', note: `${m.name}'s agent confirmed; deposit paid (capture ${c.captureId}). The rest is paid on site.`, remaining: Env.totals(s.envelope).remaining };
  }
  emit('envelope', envelopeView(s));
  return { payment_id: entry.id, status: 'held', note: req ? `Held; ${m.name} collects it when they confirm from their inbox.` : 'Held until the merchant confirms.', paypal_authorization: pp.authorizationId, remaining: Env.totals(s.envelope).remaining };
}

// The merchant confirmed: capture the held deposit (the money moves to the merchant).
export async function captureEntry(s, entryId, emit, why) {
  const e = s.envelope.entries.find((x) => x.id === entryId);
  if (!e || e.state !== 'held') throw new Error('Nothing held to collect.');
  const pp = await PayPal.capture({ authorizationId: e.paypal.authorizationId, amount: e.amount, currency: s.envelope.currency });
  Env.capture(s.envelope, e.id, { captureId: pp.captureId, captureStatus: pp.status });
  emit('payment', { kind: 'capture', entry: e, mode: pp.mode, why });
  return pp;
}

// Money committed today (held or paid) across all of the user's missions, for the daily limit.
function spentToday(s) {
  const day = new Date().toISOString().slice(0, 10);
  const missions = [s, ...(s._user?.missions || []).filter((id) => id !== s.id).map(getMission).filter(Boolean)];
  return round(missions.flatMap((m) => m.envelope.entries).filter((e) => (e.state === 'held' || e.state === 'captured') && String(e.at).startsWith(day)).reduce((t, e) => t + e.amount - (e.refunded || 0), 0));
}

// The user tapped Approve (or Decline) on a pending payment.
export async function resolveApproval(s, approvalId, approved, emit) {
  const ap = s.approvals[approvalId];
  if (!ap || ap.status !== 'pending') throw new Error('No pending approval ' + approvalId);
  ap.status = approved ? 'approved' : 'declined';
  if (!approved) {
    emit('approval_resolved', { id: approvalId, approved: false });
    return userTurn(s, `[system] The user declined the ${ap.label} payment of ${ap.amount}. Adapt the plan.`, emit);
  }
  const r = await doHold(s, { merchant: merchant(ap.merchant_id), amount: ap.amount, label: ap.label }, emit);
  emit('approval_resolved', { id: approvalId, approved: true, result: r });
  return userTurn(s, `[system] The user approved: ${ap.label}, ${ap.amount} held with PayPal (${JSON.stringify(r)}). Continue the plan.`, emit);
}

// A merchant without an AI agent accepted (or declined) a booking request from its inbox.
// The merchant answered from their inbox: accept, decline, or propose another time.
export async function resolveRequest(s, requestId, { action, slot, message } = {}, emit) {
  const req = s.requests[requestId];
  if (!req || req.status !== 'pending') throw new Error('This request was already answered.');
  req.status = action === 'accept' ? 'accepted' : action === 'counter' ? 'countered' : 'declined';
  if (action === 'counter') req.counterSlot = String(slot || '').slice(0, 80);
  if (message) req.reply = String(message).slice(0, 300);
  req.answeredAt = new Date().toISOString();
  emit('request', req);
  const said = req.reply ? ` Their message: "${req.reply}".` : '';
  const note = action === 'accept'
    ? `[system] ${req.merchant} accepted the booking request (${req.slot}). Total ${req.total}, deposit ${req.deposit}.${said} Hold the deposit now with hold_deposit and update the plan.`
    : action === 'counter'
      ? `[system] ${req.merchant} cannot do ${req.slot || 'that time'} but proposes ${req.counterSlot}.${said} Ask the user if that works; if yes, send a new request_booking for that slot.`
      : `[system] ${req.merchant} declined the booking request.${said} Find an alternative.`;
  return userTurn(s, note, emit);
}

async function describeImage(dataUrl, ask) {
  const { message } = await chat({
    model: MODELS.fast,
    maxTokens: 3000,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `The user sent this photo to their personal booking/paying agent${ask ? ` with the words: "${ask}"` : ''}. Describe precisely what matters to act on it: place/business names, items with prices, dates and times, addresses, event names, totals. Plain text, max 90 words.` },
      { type: 'image_url', image_url: { url: dataUrl } },
    ] }],
  });
  return (message.content || '').trim().slice(0, 900);
}

// One line per mission for the home screen.
// What the home screen needs to sort missions by urgency and say, in plain words, what is going on.
export function missionSummary(s, { busy = false } = {}) {
  const t = Env.totals(s.envelope);
  const approval = Object.values(s.approvals).find((a) => a.status === 'pending');
  const request = Object.values(s.requests || {}).find((r) => r.status === 'pending');
  const items = (s.plan || []).filter((i) => i.status !== 'cancelled');
  const done = items.filter((i) => ['held', 'confirmed'].includes(i.status)).length;
  const lastSay = [...s.messages].reverse().find((m) => m.role === 'assistant' && m.content?.trim())?.content.trim() || '';
  const lastUserIdx = s.messages.map((m) => m.role).lastIndexOf('user');
  const lastSayIdx = s.messages.map((m) => m.role === 'assistant' && !!m.content?.trim()).lastIndexOf(true);
  const asks = !busy && lastSayIdx > lastUserIdx && /\?\s*$/.test(lastSay); // the agent's last word is a question to you
  let status, needs = '';
  if (s.frozen) status = 'stopped';
  else if (approval) { status = 'needs_you'; needs = `Approve ${Env.fmt(approval.amount, s.envelope)} at ${approval.merchant}`; }
  else if (asks) { status = 'needs_you'; needs = 'Answer: ' + lastSay.split(/(?<=[.!])\s+/).filter((x) => x.includes('?')).pop()?.slice(0, 110); }
  else if (busy) status = 'working';
  else if (request) { status = 'waiting'; needs = `Waiting for ${request.merchant} to accept`; }
  else if (Object.values(s.requests || {}).some((r) => r.status === 'accepted' && s.envelope.entries.find((e) => e.id === r.paymentId)?.state === 'held')) {
    const r = Object.values(s.requests).find((x) => x.status === 'accepted' && x.paymentId);
    status = 'waiting'; needs = `Deposit held · waiting for ${r.merchant} to confirm`;
  }
  else if (items.length && done === items.length) status = 'done';
  else status = s.messages.length ? 'idle' : 'new';
  const lastAt = (s.feed?.length ? s.feed[s.feed.length - 1].at : null) || Date.parse(s.createdAt);
  return {
    id: s.id, title: s.title, emoji: s.emoji, createdAt: s.createdAt, lastAt, archived: !!s.archived,
    status, needs, last: lastSay.slice(0, 140),
    total: t.total, remaining: t.remaining, held: t.held, spent: t.spent, currency: t.currency,
    progress: items.length ? { done, of: items.length } : null,
  };
}

export function envelopeView(s) {
  return { ...Env.totals(s.envelope), approveAbove: s.envelope.approveAbove, entries: s.envelope.entries, mandate: s.mandate ? { mode: s.mandate.mode } : null };
}

function publicUrl() {
  return process.env.PUBLIC_URL || 'http://localhost:8790';
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

function round(x) {
  return Math.round(x * 100) / 100;
}
