// The Mandat agent: one conversation, one budget envelope, tools that really search, negotiate and pay.
// Every step is emitted as an event so the interface (and the demo video) can show the agent working live.
import crypto from 'node:crypto';
import { chat, MODELS } from './deepseek.mjs';
import * as Env from './envelope.mjs';
import * as PayPal from './paypal.mjs';
import { MERCHANTS, merchant, identityCard, verifyCard, askMerchantAgent } from './merchants.mjs';
import { nearby, geocode } from './places.mjs';
import { agentBrief, approveAboveFor } from './users.mjs';

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
  fn('cancel_hold', 'Release a held deposit (void the PayPal authorization) when the plan changes.', { payment_id: { type: 'string' } }, ['payment_id']),
  fn('split_bill', 'Create a PayPal pay-your-share link for each friend.', {
    total: { type: 'number' },
    label: { type: 'string' },
    friends: { type: 'array', items: { type: 'string' } },
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

function systemPrompt(s) {
  const t = Env.totals(s.envelope);
  const brief = s._user ? agentBrief(s._user) : '';
  const autonomy = s._user?.rules?.autonomy || 'balanced';
  return `You are Mandat, a personal agent that the user trusts with a budget. You talk with the user by voice: keep every reply short (1–3 sentences), warm, natural, no lists, no markdown. Reply in the user's language.
Mandate: ${Env.fmt(t.total, s.envelope)} total for "${s.envelope.purpose || 'the user request'}". Remaining now: ${Env.fmt(t.remaining, s.envelope)}. Payments above ${s.envelope.approveAbove === null ? 'any amount' : Env.fmt(s.envelope.approveAbove, s.envelope)} need the user's tap to approve.
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
    const { message } = await chat({ model: MODELS.fast, messages: [{ role: 'system', content: systemPrompt(s) }, ...s.messages], tools: TOOLS, temperature: 0.4, maxTokens: 4000 });
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
      const items = (a.items || []).map((it) => {
        const o = m.offers.find((x) => x.sku === it.sku) || m.offers[0];
        return { sku: o.sku, label: o.label, qty: it.qty || 1, unit_price: o.price };
      });
      const total = round(items.reduce((t, it) => t + it.qty * it.unit_price, 0));
      const id = 'r_' + crypto.randomBytes(4).toString('hex');
      const req = { id, sessionId: s.id, merchant_id: m.id, merchant: m.name, items, total, deposit: round(total * m.deposit), slot: a.slot || '', note: a.note || '', status: 'pending', createdAt: new Date().toISOString() };
      s.requests[id] = req;
      emit('request', req);
      return { request_id: id, status: 'pending', total, deposit: req.deposit, info: 'The merchant will accept with one tap; you will be told. Continue with other bookings meanwhile.' };
    }
    case 'hold_deposit': {
      const m = merchant(a.merchant_id);
      if (s._user) s.envelope.approveAbove = approveAboveFor(s._user); // autonomy changes apply immediately
      const verdict = Env.check(s.envelope, a.amount);
      if (!verdict.ok) return { error: verdict.reason };
      if (verdict.needsApproval) {
        const id = 'a_' + crypto.randomBytes(4).toString('hex');
        s.approvals[id] = { id, merchant_id: m.id, merchant: m.name, amount: round(a.amount), label: a.label, offer_total: a.offer_total, status: 'pending' };
        emit('approval', s.approvals[id]);
        return { status: 'awaiting_user_approval', approval_id: id, info: 'Ask the user to approve on screen; do not wait in silence.' };
      }
      return await doHold(s, { merchant: m, amount: a.amount, label: a.label }, emit);
    }
    case 'cancel_hold': {
      const e = s.envelope.entries.find((x) => x.id === a.payment_id);
      if (!e) return { error: 'Unknown payment' };
      const r = await PayPal.release({ authorizationId: e.paypal.authorizationId });
      Env.release(s.envelope, e.id, { voidStatus: r.status });
      emit('envelope', envelopeView(s));
      return { released: true, remaining: Env.totals(s.envelope).remaining };
    }
    case 'split_bill': {
      const friends = a.friends || [];
      const per = round(a.total / (friends.length + 1));
      const links = [];
      for (const f of friends) {
        const r = await PayPal.shareLink({ amount: per, currency: s.envelope.currency, label: a.label, friend: f, returnUrl: `${publicUrl()}/share/done`, cancelUrl: `${publicUrl()}/share/cancel` });
        links.push({ friend: f, amount: per, url: r.payUrl, orderId: r.orderId, status: 'sent' });
      }
      s.shares.push(...links);
      emit('shares', { label: a.label, per, links });
      return { per_person: per, sent_to: friends };
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
  emit('envelope', envelopeView(s));
  return { payment_id: entry.id, status: 'held', paypal_authorization: pp.authorizationId, remaining: Env.totals(s.envelope).remaining };
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
export async function resolveRequest(s, requestId, accepted, emit) {
  const req = s.requests[requestId];
  if (!req || req.status !== 'pending') throw new Error('No pending request ' + requestId);
  req.status = accepted ? 'accepted' : 'declined';
  emit('request', req);
  const note = accepted
    ? `[system] ${req.merchant} accepted the booking request (${req.slot}). Total ${req.total}, deposit ${req.deposit}. Hold the deposit now with hold_deposit and update the plan.`
    : `[system] ${req.merchant} declined the booking request. Find an alternative.`;
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
export function missionSummary(s) {
  const t = Env.totals(s.envelope);
  const waiting = Object.values(s.approvals).some((a) => a.status === 'pending');
  const items = s.plan || [];
  const done = items.filter((i) => ['held', 'confirmed'].includes(i.status)).length;
  const status = s.frozen ? 'stopped' : waiting ? 'needs_you' : items.length && done === items.length ? 'done' : s.messages.length ? 'working' : 'new';
  return { id: s.id, title: s.title, emoji: s.emoji, createdAt: s.createdAt, status, total: t.total, remaining: t.remaining, held: t.held, spent: t.spent, currency: t.currency, progress: items.length ? { done, of: items.length } : null };
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
