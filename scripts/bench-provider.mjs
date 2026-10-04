// Provider comparison on one realistic mission (no UI, PayPal offline): the user answers questions with
// "decide for me", approves every payment, merchants without an agent accept. Prints what got booked and paid,
// whether the books stay inside the budget, the number of model calls and the time.
// Usage: DEEPSEEK_BASE_URL=… DEEPSEEK_KEY_FILE=… DEEPSEEK_FAST_MODEL=… node scripts/bench-provider.mjs [scenario]
import { createSession, userTurn, resolveApproval, resolveRequest, envelopeView } from '../lib/agent.mjs';
import * as PayPal from '../lib/paypal.mjs';

const SCENARIOS = {
  birthday: { budget: 400, purpose: "Girlfriend's birthday evening", ask: "Organise my girlfriend's birthday this Saturday: dinner for 6 around 8pm near me, a cake, and flowers. 400 euros max." },
  repair: { budget: 150, purpose: 'Bike repair', ask: 'My bike has a flat rear tyre and the brakes squeak. Get it fixed this week near me, 150 euros max.' },
};
const name = process.argv[2] || 'birthday';
const sc = SCENARIOS[name];
const s = createSession({ budget: sc.budget, approveAbove: 100, purpose: sc.purpose, location: { lat: 48.8647, lon: 2.3727, label: 'Rue Oberkampf, Paris 11e' } });
s.mandate = { paymentTokenId: (await PayPal.activateMandate('SETUP-DEMO')).paymentTokenId, mode: PayPal.MODE };
const queue = [];
let asked = 0, tools = 0, said = '';
const emit = (type, d) => {
  if (type === 'tool') { tools++; console.log(`🔧 ${d.name} ${JSON.stringify(d.args).slice(0, 120)}`); }
  if (type === 'say') { said = d.text; console.log(`🗣  ${String(d.text).slice(0, 220)}`); }
  if (type === 'choices') asked++;
  if (type === 'payment') console.log(`💳 ${d.kind} ${d.entry.merchant} ${d.entry.amount} → ${d.entry.state}`);
  if (type === 'approval') queue.push(['approval', d.id]);
  if (type === 'request' && d.status === 'pending') queue.push(['request', d.id]);
};
const t0 = Date.now();
await userTurn(s, sc.ask, emit);
// A question asked with tap answers or in plain words gets the same answer: decide and go on.
for (let round = 0; round < 3 && (asked || /\?\s*$|\?\s*>>/m.test(said)); round++) { asked = 0; said = ''; await userTurn(s, 'Decide for me and go ahead, I trust you.', emit); }
for (let i = 0; i < 14 && queue.length; i++) {
  const [kind, id] = queue.shift();
  if (kind === 'approval') await resolveApproval(s, id, true, emit);
  else await resolveRequest(s, id, { action: 'accept' }, emit);
}
const v = envelopeView(s);
const plan = (s.plan || []).map((i) => `${i.what?.slice(0, 40)} @ ${i.merchant || '?'} = ${i.status}`);
console.log('\nPLAN\n  ' + plan.join('\n  '));
console.log(`\nRESULT ${name}: budget ${v.total} · committed ${v.committed} · left ${v.left} · paid ${v.spent} · held ${v.held} · inside budget ${v.left >= 0 ? 'YES' : 'NO'} · tool calls ${tools} · ${Math.round((Date.now() - t0) / 1000)} s`);
