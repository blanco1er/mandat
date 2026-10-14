// The app says which open model runs the agent and who serves it (never the key).
import test from 'node:test';
import assert from 'node:assert/strict';

test('Nemotron on Nebius Token Factory is named in words people know', async () => {
  process.env.DEEPSEEK_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
  process.env.DEEPSEEK_FAST_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
  const { aiLabel } = await import('../lib/llm.mjs');
  assert.deepEqual(aiLabel(), { model: 'NVIDIA Nemotron 3 Super', host: 'Nebius Token Factory' });
});
