// With no configuration at all, Mandat runs on NVIDIA Nemotron through Nebius Token Factory.
import test from 'node:test';
import assert from 'node:assert/strict';

test('defaults: Nemotron 3 Super runs, Nemotron 3 Ultra reviews, Gemma reads photos, on Token Factory', async () => {
  for (const k of Object.keys(process.env)) if (/^(LLM|DEEPSEEK)_/.test(k)) delete process.env[k];
  const { MODELS, aiLabel } = await import('../lib/llm.mjs');
  assert.equal(MODELS.fast, 'nvidia/nemotron-3-super-120b-a12b');
  assert.equal(MODELS.smart, 'nvidia/Nemotron-3-Ultra-550b-a55b');
  assert.equal(MODELS.review, MODELS.smart);
  assert.equal(MODELS.vision, 'google/gemma-3-27b-it');
  assert.equal(aiLabel().host, 'Nebius Token Factory');
});
