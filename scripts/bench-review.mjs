// The plan reviewer on six plans with a known flaw (or none): which model finds the real problem, how fast,
// and how often it invents one. Usage: DEEPSEEK_BASE_URL=… DEEPSEEK_KEY_FILE=… node scripts/bench-review.mjs [reps]
import { reviewPlan } from '../lib/agent.mjs';
import { createEnvelope } from '../lib/envelope.mjs';

const MODELS = (process.env.BENCH_MODELS || 'nvidia/nemotron-3-super-120b-a12b,nvidia/Nemotron-3-Ultra-550b-a55b').split(',');
const reps = Number(process.argv[2]) || 3;
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7) + n); return d.toISOString().slice(0, 10); }; // next Saturday + n
const SAT = day(0), SUN = day(1);
const req = (merchant, status, items, slot) => ({ merchant, status, items: items.map((label) => ({ qty: 1, label })), slot });
const CASES = [
  { name: 'birthday: flowers forgotten', ask: `My mum turns 60 on Saturday: dinner for 8 at 20:00, a cake delivered to the restaurant, and flowers. 550 € max.`,
    requests: [req('Lumière', 'accepted', ['Dinner for 8, tasting menu'], `${SAT} 20:00`), req('Atelier Sucré', 'accepted', ['Celebration cake for 8, delivered to Lumière'], `${SAT} 19:30`)],
    expect: { found: /flower|bouquet|florist/i } },
  { name: 'trip: one night without a stay', ask: 'Three nights in Barcelona from Friday, train from Paris and back, 700 € max.',
    requests: [req('Renfe-SNCF', 'accepted', ['Paris → Barcelona'], `${day(-1)} 08:00`), req('Renfe-SNCF', 'accepted', ['Barcelona → Paris'], `${day(2)} 17:00`), req('Mar Blau', 'accepted', ['Double room, 2 nights'], `${day(-1)}`)],
    expect: { found: /night|stay|hotel|accommodation/i } },
  { name: 'event: caterer with no venue', ask: 'A party for 40 people on Saturday evening for my 30th, catering and a DJ, 2500 € max.',
    requests: [req('Traiteur Lys', 'accepted', ['Buffet for 40'], `${SAT} 19:00`), req('DJ Nova', 'accepted', ['DJ set 4h'], `${SAT} 21:00`)],
    expect: { found: /venue|room|place|location/i } },
  { name: 'simple: a bouquet, nothing missing', ask: 'A bouquet of peonies delivered to my office on Friday, 60 € max.',
    requests: [req('La Pivoine', 'accepted', ['Bouquet of peonies, delivered to the office, 12 rue de la Paix, Paris 2e'], `${day(-1)} 10:00`)],
    expect: { clean: true } },
  { name: 'change of mind: 6 people now, table for 8', ask: 'Dinner for 8 on Saturday at 20:00 near Oberkampf, 400 € max.', said: ['Actually we will only be 6.'],
    requests: [req('Lumière', 'accepted', ['Table for 8'], `${SAT} 20:00`)],
    expect: { found: /\b(6|8|six|eight)\b|obsolete|people|guests|quantit/i } },
  { name: 'wrong day: Sunday booked for Saturday', ask: 'Brunch for 4 on Saturday at 11:00, 120 € max.',
    requests: [req('Café Lumen', 'accepted', ['Brunch for 4'], `${SUN} 11:00`)],
    expect: { found: /sunday|date|day|saturday/i } },
];

const results = {};
for (const model of MODELS) {
  results[model] = { right: 0, invented: 0, total: 0, ms: [] };
  const jobs = [];
  for (const c of CASES) for (let r = 0; r < reps; r++) jobs.push(c);
  await Promise.all(jobs.map(async (c) => {
    const s = { messages: [{ role: 'user', content: c.ask }, ...(c.said || []).map((t) => ({ role: 'user', content: t }))], requests: Object.fromEntries(c.requests.map((x, i) => ['r' + i, x])), envelope: createEnvelope({ total: 1000 }), plan: [], _user: { tz: 'Europe/Paris' } };
    const t0 = Date.now();
    let rv = null;
    try { rv = await reviewPlan(s, { model }); } catch (e) { rv = { error: e.message }; }
    const ms = Date.now() - t0;
    const text = [...(rv?.missing || []), ...(rv?.issues || [])].join(' | ');
    const ok = c.expect.clean ? !text : c.expect.found.test(text);
    const r = results[model];
    r.total++; r.ms.push(ms); if (ok) r.right++; if (c.expect.clean && text) r.invented++;
    console.log(`${ok ? '✔' : '✖'} ${model.split('/')[1].slice(0, 22).padEnd(22)} ${String(ms).padStart(6)} ms  ${c.name}: ${rv?.error || text || '(nothing)'}`.slice(0, 240));
  }));
}
console.log('\nRESULT');
for (const [model, r] of Object.entries(results)) {
  const ms = r.ms.sort((a, b) => a - b);
  console.log(`${model}: right ${r.right}/${r.total} · invented on the clean plan ${r.invented}/${reps} · median ${ms[Math.floor(ms.length / 2)]} ms · max ${ms[ms.length - 1]} ms`);
}
