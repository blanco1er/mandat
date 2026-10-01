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

const down = new Map(); // model -> skip until (ms)

// One chat completion. `tools` follows the OpenAI function-calling schema.
// If the model hangs or errors transiently, the call moves once to `fallback` (text-only calls), so a mission never freezes.
export async function chat({ messages, tools, model = MODELS.fast, temperature = 0.4, json = false, maxTokens = 1200, fallback = null }) {
  const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
  const alt = fallback && !hasImage && fallback !== model ? fallback : null;
  // Circuit breaker: a model that just hung is skipped for a few minutes instead of making every step wait.
  const plan = alt && (down.get(model) || 0) > Date.now() ? [alt] : [model, alt || model];
  for (let attempt = 0; attempt < plan.length; attempt++) {
    const use = plan[attempt];
    const body = { model: use, messages, temperature, max_tokens: maxTokens };
    if (tools?.length) body.tools = tools;
    if (json) body.response_format = { type: 'json_object' };
    const started = Date.now();
    try {
      const res = await fetch(BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(use === MODELS.fast ? 25000 : 60000),
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 300)}`);
        err.retry = res.status === 429 || res.status >= 500;
        throw err;
      }
      const data = await res.json();
      logUsage(use, data.usage, Date.now() - started);
      return { message: data.choices[0].message, usage: data.usage };
    } catch (e) {
      if (e.name === 'TimeoutError' || e.retry) down.set(use, Date.now() + 5 * 60 * 1000);
      const transient = e.retry || e.name === 'TimeoutError' || e.name === 'AbortError' || e.cause?.code === 'ECONNRESET';
      if (attempt === plan.length - 1 || !transient) throw e.name === 'TimeoutError' ? new Error('The AI took too long to answer. Try again.') : e;
      console.warn(`[deepseek] ${use} ${e.name === 'TimeoutError' ? 'timed out' : e.message} → ${plan[attempt + 1]}`);
    }
  }
}

// One line per call: what it cost in tokens and how much the prefix cache saved.
function logUsage(model, u, ms) {
  if (!u) return;
  const hit = u.prompt_cache_hit_tokens ?? 0;
  console.log(`[deepseek] ${model} ${ms} ms · in ${u.prompt_tokens} (cache ${u.prompt_tokens ? Math.round((100 * hit) / u.prompt_tokens) : 0}%) · out ${u.completion_tokens}`);
}
