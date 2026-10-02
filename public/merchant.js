// Merchant inbox: a merchant without an AI agent answers booking requests from shoppers' agents in one tap.
const $ = (s) => document.querySelector(s);
const mid = location.pathname.split('/').pop();
const k = new URLSearchParams(location.search).get('k') || '';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: v % 1 ? 2 : 0 }).format(v || 0);
const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const STATUS = { accepted: ['Accepted', 'wait'], confirmed: ['Confirmed · deposit paid', 'paid'], declined: ['Declined', 'off'], countered: ['Other time proposed', 'part'] };
let shown = '';

async function load() {
  const r = await fetch(`/api/merchants/${mid}/requests?k=${encodeURIComponent(k)}`);
  const data = await r.json();
  if (!r.ok) {
    $('#inbox').innerHTML = `<p class="err">${esc(data.error || 'This inbox is not available.')}</p>`;
    return;
  }
  const m = data.merchant;
  document.title = `${m.name} · Inbox`;
  $('#mLogo').textContent = m.name[0];
  $('#mName').textContent = m.name;
  $('#mMeta').textContent = `${m.category[0].toUpperCase() + m.category.slice(1)} · ${m.city} · requests from AI shopping agents`;
  // Re-render only when something changed, so a half-typed counter-proposal is never wiped.
  const sig = JSON.stringify(data.requests.map((x) => [x.id, x.status, x.deposit_state]));
  if (sig === shown) return;
  shown = sig;
  const pending = data.requests.filter((x) => x.status === 'pending');
  const done = data.requests.filter((x) => x.status !== 'pending');
  $('#pending').innerHTML = pending.length ? '' : '<div class="empty-box">No request waiting. New ones appear here by themselves.</div>';
  for (const x of pending) $('#pending').append(card(x, m));
  $('#doneTitle').hidden = !done.length;
  $('#done').innerHTML = done.map((x) => {
    const [label, cls] = STATUS[x.status] || [x.status, 'off'];
    const collect = x.status === 'accepted' && x.deposit_state === 'held' ? `<button class="btn accept collect" data-rid="${x.id}">Confirm &amp; collect ${fmt(x.deposit_held)}</button>` : x.status === 'accepted' ? '<small class="wait-dep">Waiting for the customer’s agent to hold the deposit…</small>' : '';
    return `<div class="done-row"><div class="grow"><b>${esc(x.customer)}</b> · ${esc(x.items.map((i) => `${i.qty}× ${i.label}`).join(', '))}<small>${esc(x.slot || 'No time given')}${x.counterSlot ? ' → ' + esc(x.counterSlot) : ''} · ${fmt(x.total)}</small>${collect}</div><span class="chip ${cls}">${label}</span></div>`;
  }).join('');
  for (const b of document.querySelectorAll('.collect')) b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = 'Collecting with PayPal…';
    const r = await fetch(`/api/merchants/${mid}/requests/${b.dataset.rid}/collect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k }) });
    if (!r.ok) alert((await r.json()).error);
    shown = '';
    load();
  });
}

function card(x, m) {
  const el = document.createElement('article');
  el.className = 'req-card';
  el.innerHTML = `<div class="req-top"><b>${esc(x.customer)}</b><time>${when(x.createdAt)}</time></div>
    <div class="req-via">Booked by their Mandat agent · paid with PayPal</div>
    ${x.slot ? `<span class="req-when">🕒 ${esc(x.slot)}</span>` : ''}
    <ul class="req-lines">${x.items.map((i) => `<li><span>${i.qty}× ${esc(i.label)}</span><span>${fmt(i.qty * i.unit_price)}</span></li>`).join('')}<li class="total"><span>Total</span><span>${fmt(x.total)}</span></li></ul>
    ${x.note ? `<p class="req-note">“${esc(x.note)}”</p>` : ''}
    <p class="req-deposit">Deposit ${fmt(x.deposit)} (${Math.round(m.deposit * 100)}%) — held with PayPal as soon as you accept, paid to you when the booking is confirmed.</p>
    <div class="req-actions"><button class="btn accept" data-a="accept">Accept</button><button class="btn other" data-a="other">Other time</button><button class="btn decline" data-a="decline">Decline</button></div>
    <div class="counter" hidden><input placeholder="e.g. Tomorrow 9:00" aria-label="The time you can do"><button class="btn accept" data-a="counter">Propose</button></div>`;
  const send = async (action, slot) => {
    el.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const r = await fetch(`/api/merchants/${mid}/requests/${x.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k, action, slot }) });
    const out = await r.json();
    if (!r.ok) {
      el.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return alert(out.error);
    }
    shown = '';
    load();
  };
  el.querySelector('[data-a=accept]').addEventListener('click', () => send('accept'));
  el.querySelector('[data-a=decline]').addEventListener('click', () => send('decline'));
  el.querySelector('[data-a=other]').addEventListener('click', () => {
    el.querySelector('.counter').hidden = false;
    el.querySelector('.counter input').focus();
  });
  el.querySelector('[data-a=counter]').addEventListener('click', () => {
    const slot = el.querySelector('.counter input').value.trim();
    if (slot) send('counter', slot);
  });
  return el;
}

load();
setInterval(load, 8000);
