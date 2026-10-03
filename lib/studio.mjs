// AG Studio: the spending dashboard (Activity tab) and its agent.
//
// 1. insightsData() gives the dashboard two tables straight from the books: every payment (deposits held,
//    captured, released or refunded, bill shares) and every mission with its budget, what is committed at
//    full price and what is really left. The numbers are the ones the agent itself works from.
// 2. studioTurn() is the server side of the Studio Agent Framework adapter. The browser's AgLlmAdapter
//    posts AG Studio's request (conversation items, tool schemas, tool choice) here; it is translated to
//    an OpenAI-style chat completion for DeepSeek and the answer comes back as AG Studio output items.
//    The key never reaches the browser, and the tools still run in the page, as the framework intends.
import { chat, MODELS } from './deepseek.mjs';
import { envelopeView, ledgerBrief } from './agent.mjs';
import { MERCHANTS } from './merchants.mjs';

const round = (x) => Math.round(x * 100) / 100;
const STATUS = { held: 'Held', captured: 'Paid', released: 'Released', refunded: 'Refunded', failed: 'Failed' };
const CATEGORY = {
  restaurant: 'Food & drink', bakery: 'Food & drink', catering: 'Food & drink', hotel: 'Stays', train: 'Transport', ride: 'Transport',
  activity: 'Activities', entertainment: 'Activities', venue: 'Venues', decoration: 'Decoration', florist: 'Flowers', repair: 'Repairs', shop: 'Shopping',
};
function categoryOf(name) {
  const m = MERCHANTS.find((x) => x.name === name);
  if (!m && /\.[a-z]{2,}$/i.test(String(name || '').trim())) return 'Shopping'; // an online retailer (Channel3)
  return CATEGORY[m?.category] || (m?.category ? m.category[0].toUpperCase() + m.category.slice(1) : 'Other');
}

export function insightsData(u, getMission) {
  const payments = [], missions = [];
  for (const id of u.missions) {
    const m = getMission(id);
    if (!m) continue;
    const v = envelopeView(m);
    const currency = m.envelope.currency || 'EUR';
    missions.push({
      mission_id: m.id, mission: m.title || 'Mission', created: m.createdAt, city: m.location?.city || m.location?.label || '',
      budget: round(m.envelope.total), committed: v.committed, left: v.left, paid: round(v.spent || 0), held: round(v.held || 0), still_to_pay: v.due, currency,
    });
    for (const e of m.envelope.entries) {
      const full = Number(e.total) > e.amount ? Number(e.total) : e.amount;
      const live = e.state === 'held' || e.state === 'captured';
      payments.push({
        payment_id: e.id, mission_id: m.id, date: e.at, merchant: e.merchant, category: categoryOf(e.merchant), what: e.label,
        kind: 'Deposit', status: STATUS[e.state] || e.state, amount: e.amount, // the amount as held or paid at first
        spent: e.state === 'captured' || e.state === 'refunded' ? round(e.amount - (e.refunded || 0)) : 0,
        held: e.state === 'held' ? e.amount : 0,
        refunded: round(e.refunded || 0),
        full_price: live ? full : 0,
        balance_due: live ? round(Math.max(0, full - e.amount)) : 0,
        paypal_ref: e.paypal?.captureId || e.paypal?.authorizationId || '', currency,
      });
    }
    for (const sh of m.shares || []) {
      if (!sh.invoiceId) continue;
      payments.push({
        payment_id: sh.invoiceId, mission_id: m.id, date: sh.at || m.createdAt, merchant: sh.friend, category: 'Bill shares', what: sh.label || '',
        kind: 'Bill share', status: sh.status === 'PAID' ? 'Paid back' : 'Owed to you', amount: sh.amount, spent: 0, held: 0, refunded: 0, full_price: 0,
        balance_due: 0, owed_to_you: sh.status === 'PAID' ? 0 : sh.amount, paid_back: sh.status === 'PAID' ? sh.amount : 0, paypal_ref: sh.invoiceId, currency,
      });
    }
  }
  for (const p of payments) { p.owed_to_you ??= 0; p.paid_back ??= 0; }
  payments.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { payments, missions };
}

// The books of every mission, written by the code (never added up by a model): what the dashboard agent
// reads when it is asked why an amount is what it is.
export function booksOf(u, getMission, missionId = '') {
  return u.missions.map(getMission).filter((m) => m && (!missionId || m.id === missionId))
    .map((m) => ({ mission_id: m.id, mission: m.title || 'Mission', books: ledgerBrief(m) || 'No payment or booking yet.' }));
}

// ---------- the adapter, server side ----------
// DeepSeek's thinking mode wants its own reasoning sent back with the tool calls it made. AG Studio resends the
// conversation without it, so the reasoning of each turn is kept here for a while, keyed by its tool calls.
const thoughts = new Map(); // callId -> { reasoning, at }
function keepThought(calls, reasoning) {
  if (!reasoning || !calls?.length) return;
  for (const c of calls) thoughts.set(c.id, { reasoning, at: Date.now() });
  if (thoughts.size > 2000) for (const [k, v] of thoughts) if (Date.now() - v.at > 3600e3 || thoughts.size > 1500) thoughts.delete(k);
}
const text = (content) => (Array.isArray(content) ? content : []).map((c) => c.text || c.refusal || '').filter(Boolean).join('\n');

function toMessages(req) {
  const out = [];
  const sys = [String(req.instructions || '')];
  if (req.responseFormat?.type === 'json') sys.push(`Answer with one JSON object only, matching this JSON schema (${req.responseFormat.name}): ${JSON.stringify(req.responseFormat.schema).slice(0, 6000)}`);
  out.push({ role: 'system', content: sys.filter(Boolean).join('\n\n') || 'You help the user with their dashboard.' });
  for (const it of req.input || []) {
    if (it.type === 'message' && (it.role === 'user' || it.role === 'system')) out.push({ role: it.role === 'system' ? 'system' : 'user', content: text(it.content) });
    else if (it.type === 'message' && it.role === 'assistant') out.push({ role: 'assistant', content: text(it.content) });
    else if (it.type === 'function_call') {
      const call = { id: it.callId, type: 'function', function: { name: it.name, arguments: it.arguments || '{}' } };
      const last = out[out.length - 1];
      // consecutive calls of one turn belong to one assistant message
      if (last?.role === 'assistant' && last.tool_calls) last.tool_calls.push(call);
      else if (last?.role === 'assistant' && !last.tool_calls) Object.assign(last, { tool_calls: [call] }); // text and calls of one turn
      else out.push({ role: 'assistant', content: '', tool_calls: [call] });
      // the thinking mode refuses a tool call sent back without its reasoning: the kept one, or an empty one
      const kept = thoughts.get(it.callId);
      const msg = out[out.length - 1];
      if (kept) msg.reasoning_content = kept.reasoning;
      else msg.reasoning_content ??= '';
    } else if (it.type === 'function_call_output') out.push({ role: 'tool', tool_call_id: it.callId, content: String(it.output ?? '') });
    // reasoning items are not sent back
  }
  return out;
}

export async function studioTurn(req) {
  const tools = (req.tools || []).filter((t) => t.kind !== 'provided' && t.kind !== 'server').map((t) => ({ type: 'function', function: { name: t.name, description: String(t.description || '').slice(0, 1024), parameters: t.parameters || { type: 'object', properties: {} } } }));
  const choice = req.toolChoice;
  const toolChoice = !tools.length ? undefined : typeof choice === 'object' && choice?.name ? { type: 'function', function: { name: choice.name } } : ['auto', 'none', 'required'].includes(choice) ? choice : undefined;
  const debug = process.env.MANDAT_STUDIO_DEBUG === '1';
  let message, usage;
  try {
    ({ message, usage } = await chat({
    model: MODELS.fast, fallback: MODELS.smart, temperature: 0.2, maxTokens: 8000, timeoutMs: 60000,
    json: req.responseFormat?.type === 'json' && !tools.length,
    messages: toMessages(req), tools, toolChoice,
    }));
  } catch (e) {
    console.warn('[studio] model call failed:', e.message.slice(0, 300));
    throw e;
  }
  if (debug) console.log('[studio]', JSON.stringify({ items: (req.input || []).length, tools: tools.map((t) => t.function.name), toolChoice, fmt: req.responseFormat?.type, text: (message.content || '').slice(0, 120), calls: (message.tool_calls || []).map((c) => c.function.name + ' ' + (c.function.arguments || '').slice(0, 160)) }));
  keepThought(message.tool_calls, message.reasoning_content);
  const output = [];
  const id = () => 'it_' + Math.random().toString(36).slice(2, 12);
  if (message.content) output.push({ id: id(), kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text: message.content, annotations: [] }] });
  for (const c of message.tool_calls || []) output.push({ id: id(), kind: 'output', type: 'function_call', callId: c.id, name: c.function.name, arguments: c.function.arguments || '{}', status: 'completed' });
  return {
    output,
    model: MODELS.fast,
    usage: usage ? { inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0, totalTokens: usage.total_tokens, cachedInputTokens: usage.prompt_cache_hit_tokens } : undefined,
  };
}
