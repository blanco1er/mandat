// The real agent loop on the simulated provider: one round of questions, then work; local things from local
// merchants; thinking out loud never reaches the user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useMock } from './mock-provider.mjs';

test('opening, work, no taste question, clean words', async () => {
  const mock = await useMock({ rewrite: (body) => (/thinking out loud/.test(body.messages[0].content) ? 'The cake fits: €53.60 is left in the budget.' : 'ok') });
  const { createSession, userTurn } = await import('../lib/agent.mjs');
  const s = createSession({ budget: 550, purpose: 'Birthday dinner', location: { lat: 48.8647, lon: 2.3727, label: 'Rue Oberkampf, Paris 11e' } });
  s.mandate = { paymentTokenId: 'PTOKEN-TEST', mode: 'offline' };
  const events = [];
  const emit = (type, d) => events.push([type, d]);
  const says = () => events.filter(([t]) => t === 'say').map(([, d]) => d.text);
  const choiceRounds = () => events.filter(([t]) => t === 'choices').length;

  // 1. The opening: the questions together, one row of complete answers.
  mock.agent.push({ content: 'A dinner for 8 on Saturday, a cake and flowers, 550 €. A few questions:\n1. Cuisine?\n2. Cake?\n3. Flowers?\n>> French, chocolate, mixed bouquet | Italian, fruit tart, roses | You decide' });
  await userTurn(s, 'My mum turns 60 on Saturday: dinner for 8 around 8pm, a cake delivered to the restaurant, and flowers. 550 € max.', emit);
  assert.equal(choiceRounds(), 1);

  // 2. Answered: the next call must use a tool; a cake is never searched as a shipped product; a question of
  //    taste is not shown (the agent decides); a reply thinking out loud is rewritten.
  const before = mock.requests.length;
  mock.agent.push(
    { tools: [['find_products', { query: 'chocolate birthday cake delivery Paris', need: 'a cake for 8' }]] },
    { content: 'Cake flavour?\n>> Chocolate, vanilla | Fruit tart, lemon | You decide' },
    { content: 'Over by €11? Wait compute: 296.40 + 50 = 346.40, so €53.60 is left.' },
  );
  await userTurn(s, 'French, chocolate, mixed bouquet', emit);

  const agentCalls = mock.requests.slice(before).filter((b) => b.tools?.length && /You are Mandat/.test(b.messages[0].content));
  assert.equal(agentCalls[0].tool_choice, 'required', 'after the opening answers, the agent must act');
  const productResult = s.messages.find((m) => m.role === 'tool' && /local bakery/.test(m.content));
  assert.ok(productResult, 'the cake search was sent to the network bakery');
  assert.equal(choiceRounds(), 1, 'the taste question was never shown');
  assert.ok(s.messages.some((m) => /Do not ask the user this/.test(m.content)), 'the agent was told to decide');
  assert.ok(says().includes('The cake fits: €53.60 is left in the budget.'), 'the clean message was shown');
  assert.ok(!says().some((t) => /Wait compute/.test(t)), 'the thinking was never shown');
  await mock.close();
});
