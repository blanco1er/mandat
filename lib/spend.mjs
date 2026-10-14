// What the models cost, call by call, and a hard ceiling for the hosted demo: once the budget set for it is
// used, no model call leaves the server and people get a clear sentence instead of a broken agent.
// MANDAT_LLM_BUDGET_USD: the ceiling for the whole demo (0 or empty: no ceiling). The running total is kept in
// data/llm-spend.json, so it survives restarts (and is mirrored to R2 with the rest of data/).
// MANDAT_LLM_PRICES: JSON {"model id": [USD per million input tokens, USD per million output tokens]} to override.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, persist } from './store.mjs';

// Nebius Token Factory prices (USD per million tokens, input / output), as listed by price trackers in October
// 2026 (the official price page needs a login); no prefix-cache discount is counted, so the estimate is high.
const DEFAULT_PRICES = {
  'nvidia/nemotron-3-super-120b-a12b': [0.3, 0.9],
  'nvidia/Nemotron-3-Ultra-550b-a55b': [1.0, 3.0],
  'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B': [0.06, 0.24],
  'nvidia/Nemotron-3_5-Lightning': [0.06, 0.24],
  'google/gemma-3-27b-it': [0.1, 0.3],
};
let PRICES = DEFAULT_PRICES;
try { if (process.env.MANDAT_LLM_PRICES) PRICES = { ...DEFAULT_PRICES, ...JSON.parse(process.env.MANDAT_LLM_PRICES) }; } catch { console.warn('[spend] MANDAT_LLM_PRICES is not valid JSON: list prices used'); }
// An unknown model is counted at the highest known price: the ceiling is never reached late.
const WORST = Object.values(PRICES).reduce((w, p) => [Math.max(w[0], p[0]), Math.max(w[1], p[1])], [0, 0]);

export const budget = () => Math.max(0, Number(process.env.MANDAT_LLM_BUDGET_USD) || 0);
const FILE = () => path.join(DATA, 'llm-spend.json');
let state = null;
function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { state = null; }
  if (!state || typeof state.usd !== 'number') state = { usd: 0, calls: 0, since: new Date().toISOString(), byModel: {} };
  return state;
}
let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(FILE() + '.tmp', JSON.stringify(state, null, 2));
      fs.renameSync(FILE() + '.tmp', FILE());
      persist(FILE());
    } catch (e) { console.warn('[spend]', e.message); }
  }, 500);
  timer.unref?.();
}

export const costOf = (model, inTok = 0, outTok = 0) => {
  const [pi, po] = PRICES[model] || WORST;
  return ((Number(inTok) || 0) * pi + (Number(outTok) || 0) * po) / 1e6;
};

// After each call: count what it cost.
export function addUsage(model, usage) {
  if (!usage) return 0;
  const s = load();
  const usd = costOf(model, usage.prompt_tokens, usage.completion_tokens);
  const m = (s.byModel[model] ||= { calls: 0, in: 0, out: 0, usd: 0 });
  m.calls++; m.in += usage.prompt_tokens || 0; m.out += usage.completion_tokens || 0; m.usd = round(m.usd + usd);
  s.calls++; s.usd = round(s.usd + usd);
  const cap = budget();
  if (cap && !s.warned && s.usd >= cap * 0.8) { s.warned = true; console.warn(`[spend] 80% of the model budget used: $${s.usd.toFixed(2)} of $${cap}`); }
  save();
  return usd;
}
const round = (v) => Math.round(v * 1e6) / 1e6;

// Before each call: is there budget left?
export const exhausted = () => { const cap = budget(); return cap > 0 && load().usd >= cap; };
export function spendView() {
  const s = load(), cap = budget();
  return { usd: round(s.usd), calls: s.calls, since: s.since, budget: cap || null, left: cap ? Math.max(0, round(cap - s.usd)) : null, paused: exhausted() };
}
export function budgetError() {
  return Object.assign(new Error('The AI budget set for this demo is used up, so Mandat cannot think right now. Your missions, payments and agenda are all still here.'), { code: 'LLM_BUDGET', status: 503 });
}
// Tests only: start from a clean slate.
export function _reset() { state = { usd: 0, calls: 0, since: new Date().toISOString(), byModel: {} }; }
