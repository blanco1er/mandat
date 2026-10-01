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

// One chat completion. `tools` follows the OpenAI function-calling schema.
export async function chat({ messages, tools, model = MODELS.fast, temperature = 0.4, json = false, maxTokens = 1200 }) {
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (tools?.length) body.tools = tools;
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return { message: data.choices[0].message, usage: data.usage };
}
