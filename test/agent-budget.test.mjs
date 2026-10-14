// The hosted demo's model budget: once used, no call leaves the server and the user gets a clear sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useMock } from './mock-provider.mjs';

test('spend is counted per call and the ceiling stops every call', async () => {
  const mock = await useMock({ usage: { prompt_tokens: 12000, completion_tokens: 400 } });
  const spend = await import('../lib/spend.mjs');
  const { chat, MODELS } = await import('../lib/llm.mjs');
  spend._reset();
  process.env.MANDAT_LLM_BUDGET_USD = '0.01';
  // 12k in + 400 out on Nemotron 3 Super = 12000 × 0.30 + 400 × 0.90 per million = $0.00396
  assert.equal(Math.round(spend.costOf(MODELS.fast, 12000, 400) * 1e5) / 1e5, 0.00396);
  await chat({ messages: [{ role: 'user', content: 'one' }] });
  await chat({ messages: [{ role: 'user', content: 'two' }] });
  assert.equal(spend.exhausted(), false);
  await chat({ messages: [{ role: 'user', content: 'three' }] }); // $0.0119 > $0.01
  assert.equal(spend.exhausted(), true);
  const sent = mock.requests.length;
  await assert.rejects(chat({ messages: [{ role: 'user', content: 'four' }] }), (e) => e.code === 'LLM_BUDGET' && /budget/.test(e.message));
  assert.equal(mock.requests.length, sent, 'nothing left the server');
  assert.equal(spend.spendView().paused, true);
  delete process.env.MANDAT_LLM_BUDGET_USD;
  assert.equal(spend.exhausted(), false, 'no ceiling set: never paused');
  await mock.close();
});
