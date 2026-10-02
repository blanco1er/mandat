// End-to-end text scenario (no UI): the birthday evening. Auto-approves payments and auto-accepts merchant requests.
import { createSession, userTurn, resolveApproval, resolveRequest, envelopeView } from '../lib/agent.mjs';
import * as PayPal from '../lib/paypal.mjs';

const s = createSession({ budget: 400, approveAbove: 100, purpose: "Girlfriend's birthday evening", location: { lat: 48.8647, lon: 2.3727, label: 'Rue Oberkampf, Paris 11e' } });
s.mandate = { paymentTokenId: (await PayPal.activateMandate('SETUP-DEMO')).paymentTokenId, mode: PayPal.MODE };
const queue = [];
const emit = (type, d) => {
  const short = {
    say: () => `🗣  ${d.text}`,
    tool: () => `🔧 ${d.name} ${JSON.stringify(d.args).slice(0, 140)}`,
    negotiation: () => `💬 [${d.name}] ${d.from === 'mandat' ? '→' : '←'} ${d.text}${d.offer ? `  (offer total ${d.offer.total}, deposit ${d.offer.deposit}, ${d.offer.slot})` : ''}`,
    verified: () => `🛡  ${d.name} identity ${d.ok ? 'verified' : 'REJECTED'}`,
    request: () => `📨 request to ${d.merchant}: ${d.status} (total ${d.total}, deposit ${d.deposit})`,
    approval: () => `✋ approval needed: ${d.label} ${d.amount}`,
    payment: () => `💳 ${d.kind} ${d.entry.merchant} ${d.entry.amount} [${d.mode}]`,
    envelope: () => `📊 envelope held ${d.held} spent ${d.spent} remaining ${d.remaining}`,
    plan: () => `🗒  plan: ${d.items.map((i) => `${i.what}@${i.merchant || '?'}=${i.status}`).join(' | ')}`,
    places: () => `📍 ${d.category}: ${d.places.map((p) => p.name).slice(0, 3).join(', ')}`,
    merchants: () => `🏪 network ${d.category}: ${d.merchants.map((m) => m.name + (m.hasAgent ? ' (agent)' : '')).join(', ')}`,
    shares: () => `👥 shares ${d.per} each → ${d.links.map((l) => l.friend).join(', ')}`,
  }[type];
  console.log(short ? short() : `• ${type}`);
  if (type === 'approval') queue.push(['approval', d.id]);
  if (type === 'request' && d.status === 'pending') queue.push(['request', d.id]);
};

const t0 = Date.now();
await userTurn(s, "Organise my girlfriend's birthday this Saturday: dinner for 6 around 8pm near me, a cake, and flowers. 400 euros max.", emit);
for (let i = 0; i < 12 && queue.length; i++) {
  const [kind, id] = queue.shift();
  console.log(`\n—— ${kind === 'approval' ? 'USER TAPS APPROVE' : 'MERCHANT TAPS ACCEPT'} (${id}) ——`);
  if (kind === 'approval') await resolveApproval(s, id, true, emit);
  else await resolveRequest(s, id, { action: 'accept' }, emit);
}
console.log('\nFINAL', JSON.stringify(envelopeView(s), (k, v) => (k === 'paypal' ? undefined : v)).slice(0, 600));
console.log('time', Math.round((Date.now() - t0) / 1000) + 's');
