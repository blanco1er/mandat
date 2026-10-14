// The real agent loop on the simulated provider: another time than the one asked is the user's call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useMock } from './mock-provider.mjs';

test('a merchant offering another time: nothing is held there until the user picks one', async () => {
  const mock = await useMock({
    merchant: [{ reply: 'Sorry, 20:00 is fully booked on Saturday. We can do 19:00 or 21:15.', offer: { items: [{ sku: 'dinner_menu', label: 'Dinner menu', qty: 8, unit_price: 48 }], discount: 0, total: 384, deposit: 115.2 } }],
  });
  const { createSession, userTurn } = await import('../lib/agent.mjs');
  const s = createSession({ budget: 550, purpose: 'Birthday dinner', location: { lat: 48.8647, lon: 2.3727, label: 'Rue Oberkampf, Paris 11e' } });
  s.mandate = { paymentTokenId: 'PTOKEN-TEST', mode: 'offline' };
  const events = [];
  const emit = (type, d) => events.push([type, d]);

  mock.agent.push(
    { content: 'I am asking Lumière.', tools: [['negotiate', { merchant_id: 'm_lumiere', message: 'A private table for 8 on Saturday at 20:00, tasting menu. Your best price?' }]] },
    { tools: [['hold_deposit', { merchant_id: 'm_lumiere', amount: 115.2, offer_total: 384, label: 'Restaurant deposit' }]] },
    { content: 'Lumière is full at 20:00 but can do 19:00 or 21:15.\n>> 19:00 works | 21:15 works | Look elsewhere' },
  );
  await userTurn(s, 'Dinner for 8 on Saturday at 20:00 near Oberkampf, 550 € max.', emit);

  const holdResult = s.messages.find((m) => m.role === 'tool' && /proposed|offers/.test(m.content) && /Ask the user/.test(m.content));
  assert.ok(holdResult, 'the hold was refused with a reason');
  assert.equal(s.envelope.entries.length, 0, 'no money held');
  assert.equal(Object.keys(s.approvals || {}).length, 0, 'no approval asked');
  const choices = events.filter(([t]) => t === 'choices').map(([, d]) => d.choices);
  assert.deepEqual(choices.at(-1), ['19:00 works', '21:15 works', 'Look elsewhere']);
  const note = s.messages.find((m) => m.role === 'tool' && /19:00, 21:15/.test(m.content));
  assert.ok(note, 'the agent was told which times to offer');

  // The user picks 19:00: now the deposit goes to approval.
  mock.agent.push({ tools: [['hold_deposit', { merchant_id: 'm_lumiere', amount: 115.2, offer_total: 384, label: 'Restaurant deposit' }]] }, { content: 'The deposit waits for your approval.' });
  await userTurn(s, '19:00 works', emit);
  assert.equal(Object.values(s.approvals).filter((a) => a.status === 'pending').length, 1, 'now the PayPal sheet is shown');
  await mock.close();
});
