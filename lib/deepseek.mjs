// DeepSeek client (OpenAI-compatible chat completions with tool calling).
// The key is read from an environment variable or a local 600-mode JSON file; it is never logged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_KEY_FILE = path.join(os.homedir(), 'Library/Application Support/StudioPilot/secrets/deepseek-dialogue.json');
const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

export const MODELS = {
  fast: process.env.DEEPSEEK_FAST_MODEL || 'deepseek-flash',
  smart: process.env.DEEPSEEK_SMART_MODEL || 'deepseek-v4-pro',
};

let cachedKey = null;
function apiKey() {
  if (cachedKey) return cachedKey;
  if (process.env.DEEPSEEK_API_KEY) return (cachedKey = process.env.DEEPSEEK_API_KEY);
  const file = process.env.DEEPSEEK_KEY_FILE || DEFAULT_KEY_FILE;
  if (fs.statSync(file).mode & 0o077) throw new Error('DeepSeek key file permissions are too open');
  const key = JSON.parse(fs.readFileSync(file, 'utf8')).api_key;
  if (typeof key !== 'string' || !key.trim()) throw new Error('DeepSeek key missing');
  return (cachedKey = key.trim());
}

// Health of each model. A model that hung is skipped; a tiny background probe (a few tokens)
// checks every few minutes whether it is back, so no user ever waits on a broken model.
const down = new Map(); // model -> next probe time (ms)
const probing = new Set();
const PROBE_EVERY = 5 * 60 * 1000;
export function probe(model = MODELS.fast) {
  if (probing.has(model)) return;
  probing.add(model);
  fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey() },
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'ok' }] }),
    signal: AbortSignal.timeout(15000),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      await r.json();
      if (down.delete(model)) console.log(`[deepseek] ${model} is back`);
    })
    .catch(() => {
      if (!down.has(model)) console.warn(`[deepseek] ${model} not answering — using the fallback for now`);
      down.set(model, Date.now() + PROBE_EVERY);
    })
    .finally(() => probing.delete(model));
}

// One chat completion. `tools` follows the OpenAI function-calling schema.
// With `onDelta`, the reply streams: each new piece of visible text is handed over as it arrives.
// If the model hangs or errors transiently, the call moves once to `fallback` (text-only calls), so a mission never freezes.
export async function chat({ messages, tools, model = MODELS.fast, temperature = 0.4, json = false, maxTokens = 1200, fallback = null, onDelta = null, onReset = null }) {
  const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
  const alt = fallback && !hasImage && fallback !== model ? fallback : null;
  // A model known to be down is skipped outright (and re-probed in the background when due).
  if (alt && down.has(model) && down.get(model) <= Date.now()) probe(model);
  const plan = alt && (down.has(model) || probing.has(model)) ? [alt] : [model, alt || model]; // unsure → the safe one
  for (let attempt = 0; attempt < plan.length; attempt++) {
    const use = plan[attempt];
    const body = { model: use, messages, temperature, max_tokens: maxTokens };
    if (tools?.length) body.tools = tools;
    if (json) body.response_format = { type: 'json_object' };
    if (onDelta) Object.assign(body, { stream: true, stream_options: { include_usage: true } });
    const started = Date.now();
    let streamed = false;
    try {
      const out = onDelta
        ? await streamOnce(use, body, (t) => { streamed = true; onDelta(t); })
        : await once(use, body);
      logUsage(use, out.usage, Date.now() - started);
      return out;
    } catch (e) {
      if (e.name === 'TimeoutError' || e.retry) down.set(use, Date.now() + PROBE_EVERY);
      const transient = e.retry || e.name === 'TimeoutError' || e.name === 'AbortError' || e.cause?.code === 'ECONNRESET';
      if (attempt === plan.length - 1 || !transient) throw e.name === 'TimeoutError' ? new Error('The AI took too long to answer. Try again.') : e;
      if (streamed) onReset?.(); // the half-written reply is replaced by the fallback's
      console.warn(`[deepseek] ${use} ${e.name === 'TimeoutError' ? 'timed out' : e.message} after ${Date.now() - started} ms → ${plan[attempt + 1]}`);
    }
  }
}

async function post(body, signal) {
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey() },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.retry = res.status === 429 || res.status >= 500;
    throw err;
  }
  return res;
}

async function once(model, body) {
  const res = await post(body, AbortSignal.timeout(model === MODELS.fast ? 25000 : 60000));
  const data = await res.json();
  return { message: data.choices[0].message, usage: data.usage };
}

// Streaming: a stall (no data for a while) counts as a hang, even if the reply had started.
async function streamOnce(model, body, onDelta) {
  const ctl = new AbortController();
  const idleMs = model === MODELS.fast ? 20000 : 45000;
  let idle = setTimeout(() => ctl.abort(timeoutError()), idleMs);
  const total = setTimeout(() => ctl.abort(timeoutError()), 120000);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort(timeoutError()), idleMs); };
  let content = '';
  let usage = null;
  const calls = [];
  try {
    const res = await post(body, ctl.signal);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.usage) usage = evt.usage;
        const d = evt.choices?.[0]?.delta;
        if (!d) continue;
        // Only real progress resets the stall timer; keep-alive lines while the model is stuck do not.
        if (d.content || d.reasoning_content || d.tool_calls) bump();
        if (d.content) { content += d.content; onDelta(d.content); }
        for (const tc of d.tool_calls || []) {
          const c = (calls[tc.index ?? 0] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.function.name += tc.function.name;
          if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
        }
      }
    }
  } catch (e) {
    throw ctl.signal.aborted && ctl.signal.reason?.name === 'TimeoutError' ? ctl.signal.reason : e;
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
  const message = { role: 'assistant', content };
  const tool_calls = calls.filter(Boolean);
  if (tool_calls.length) message.tool_calls = tool_calls;
  return { message, usage };
}
function timeoutError() {
  const e = new Error('timeout');
  e.name = 'TimeoutError';
  return e;
}

// One line per call: what it cost in tokens and how much the prefix cache saved.
function logUsage(model, u, ms) {
  if (!u) return;
  const hit = u.prompt_cache_hit_tokens ?? 0;
  console.log(`[deepseek] ${model} ${ms} ms · in ${u.prompt_tokens} (cache ${u.prompt_tokens ? Math.round((100 * hit) / u.prompt_tokens) : 0}%) · out ${u.completion_tokens}`);
}
