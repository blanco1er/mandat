// Mandat — client. Setup → PayPal mandate → live agent (voice + text), approvals, envelope.
const $ = (s) => document.querySelector(s);
const feed = $('#feed');
const state = { session: null, currency: 'EUR', speaking: false, listening: false, voiceOn: true, cards: {} };
const fmt = (v) => new Intl.NumberFormat(navigator.language || 'en-US', { style: 'currency', currency: state.currency }).format(v || 0);

// ---------- Setup ----------
let approveAbove = 100;
for (const b of document.querySelectorAll('#approve button')) {
  b.addEventListener('click', () => {
    document.querySelectorAll('#approve button').forEach((x) => x.removeAttribute('aria-checked'));
    b.setAttribute('aria-checked', 'true');
    approveAbove = Number(b.dataset.v);
  });
}
for (const b of document.querySelectorAll('.stepper button')) {
  b.addEventListener('click', () => {
    const i = $('#budget');
    i.value = Math.max(25, Math.min(5000, (Number(i.value) || 0) + Number(b.dataset.step)));
  });
}

fetch('/api/health').then((r) => r.json()).then((h) => {
  if (h.paypal !== 'sandbox') $('#demoNote').textContent = 'Demo mode — PayPal sandbox keys not configured yet.';
  else $('#demoNote').textContent = 'PayPal sandbox — no real money moves.';
});

$('#start').addEventListener('click', async () => {
  const intent = $('#intent').value.trim() || $('#intent').placeholder;
  const budget = Number($('#budget').value);
  const location = await locate();
  const res = await post('/api/sessions', { budget, approveAbove, purpose: intent.slice(0, 80), location, language: navigator.language });
  sessionStorage.setItem('mandat.intent', intent);
  sessionStorage.setItem('mandat.session', res.id);
  const setup = await post(`/api/sessions/${res.id}/mandate`, {});
  location_href(setup.approveUrl);
});

function location_href(url) {
  window.location.href = url;
}

// The browser timeout only starts once permission is granted: cap the whole wait ourselves.
function locate() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    const giveUp = setTimeout(() => resolve(null), 5000);
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(giveUp); resolve({ lat: p.coords.latitude, lon: p.coords.longitude, label: 'your location' }); },
      () => { clearTimeout(giveUp); resolve(null); },
      { timeout: 5000, maximumAge: 600000 }
    );
  });
}

// ---------- Live ----------
const params = new URLSearchParams(location.search);
if (params.get('session')) resume(params.get('session'), params.get('mandate') === 'active');

function resume(id, justSigned) {
  state.session = id;
  $('#setup').hidden = true;
  $('#live').hidden = false;
  $('#composer').hidden = false;
  $('#envChip').hidden = false;
  history.replaceState(null, '', '/?session=' + id);
  const es = new EventSource(`/api/sessions/${id}/events`);
  es.onmessage = (m) => handle(JSON.parse(m.data));
  const intent = sessionStorage.getItem('mandat.intent');
  if (justSigned && intent) {
    sessionStorage.removeItem('mandat.intent');
    setTimeout(() => send(intent), 400);
  }
}

$('#say').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#sayText').value.trim();
  if (!t) return;
  $('#sayText').value = '';
  send(t);
});

function send(text) {
  stopSpeaking();
  return post(`/api/sessions/${state.session}/messages`, { text });
}

function handle({ type, data }) {
  switch (type) {
    case 'user': return add(el('li', 'say user', data.text));
    case 'say': add(el('li', 'say', data.text)); return speak(data.text);
    case 'busy': return orbState(data.on ? 'thinking' : state.speaking ? 'speaking' : 'idle');
    case 'mandate': return add(step('PayPal mandate signed — the agent can now hold deposits within your budget.'));
    case 'tool': return toolStep(data);
    case 'places': return placesCard(data);
    case 'verified': return verifiedMark(data);
    case 'negotiation': return negotiation(data);
    case 'request': return requestCard(data);
    case 'approval': return openSheet(data);
    case 'approval_resolved': return closeSheet();
    case 'payment': return paymentCard(data);
    case 'envelope': return envelope(data);
    case 'plan': return planCard(data);
    case 'shares': return sharesCard(data);
    case 'error': return add(step('Something went wrong: ' + data.message));
  }
}

const PLURAL = { bakery: 'bakeries', florist: 'florists', restaurant: 'restaurants', hotel: 'hotels', bar: 'bars', cafe: 'cafés', hairdresser: 'hair salons', cinema: 'cinemas' };
const many = (c) => PLURAL[c] || c + 's';
const TOOL_LABEL = {
  find_real_places: (a) => `Looking for real ${many(a.category)} nearby`,
  find_network_merchants: (a) => `Checking ${many(a.category)} I can book and pay`,
  verify_merchant: () => 'Verifying the merchant agent identity',
  negotiate: () => null,
  request_booking: () => null,
  hold_deposit: () => null,
  cancel_hold: () => 'Releasing a hold',
  split_bill: () => 'Preparing PayPal links for your friends',
  update_plan: () => null,
};
function toolStep({ name, args }) {
  const label = TOOL_LABEL[name]?.(args);
  if (label) add(step(label));
}

function placesCard({ category, places }) {
  if (!places?.length) return;
  const li = el('li', 'card places');
  li.innerHTML = `<header><span class="avatar" style="background:#19a463">⌖</span><div><b>Real ${many(category)} near you</b><small>OpenStreetMap</small></div></header><ul>${places
    .slice(0, 4).map((p) => `<li>${esc(p.name)} <span>· ${p.distance} m${p.openingHours ? ' · ' + esc(p.openingHours.slice(0, 28)) : ''}</span></li>`).join('')}</ul>`;
  add(li);
}

function verifiedMark({ merchant_id, name, ok }) {
  state.verified = state.verified || {};
  state.verified[merchant_id] = ok;
  const card = state.cards['n:' + merchant_id];
  if (card) card.querySelector('.shield').hidden = !ok;
  add(step(`${name} — agent identity ${ok ? 'verified' : 'could not be verified'}`));
}

function negotiation({ merchant_id, name, from, text, offer }) {
  let card = state.cards['n:' + merchant_id];
  if (!card) {
    card = document.querySelector('#tpl-negotiation').content.firstElementChild.cloneNode(true);
    card.querySelector('.name').textContent = name;
    card.querySelector('.avatar').textContent = name[0];
    card.querySelector('.shield').hidden = !state.verified?.[merchant_id];
    state.cards['n:' + merchant_id] = card;
    add(card);
  }
  card.querySelector('.bubbles').append(el('li', from, text));
  if (offer) {
    const o = card.querySelector('.offer');
    o.hidden = false;
    o.innerHTML = [offer.slot && `<span>${esc(offer.slot)}</span>`, offer.discount ? `<span>−${fmt(offer.discount)}</span>` : '', `<span>deposit ${fmt(offer.deposit)}</span>`, `<span class="total">${fmt(offer.total)}</span>`].filter(Boolean).join('');
  }
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function requestCard(r) {
  let card = state.cards['r:' + r.id];
  if (!card) {
    card = el('li', 'card req');
    state.cards['r:' + r.id] = card;
    add(card);
  }
  card.classList.toggle('accepted', r.status !== 'pending');
  card.innerHTML = `<header><span class="avatar m">${esc(r.merchant[0])}</span><div><b>${esc(r.merchant)}</b><small>No AI agent · booking request sent</small></div>${
    r.status === 'pending' ? '<span class="dots"><i></i><i></i><i></i></span>' : `<span class="state">${r.status === 'accepted' ? 'Accepted' : 'Declined'}</span>`
  }</header><p>${r.items.map((i) => `${i.qty}× ${esc(i.label)}`).join(', ')}${r.slot ? ' · ' + esc(r.slot) : ''} — ${fmt(r.total)}, deposit ${fmt(r.deposit)}</p>`;
}

function paymentCard({ kind, entry, mode }) {
  const li = el('li', 'card pay' + (kind === 'capture' ? ' captured' : ''));
  li.innerHTML = `<span class="lock">${kind === 'hold' ? '🔒' : '✓'}</span><div><b>${kind === 'hold' ? 'Held with PayPal' : 'Paid with PayPal'}</b><small>${esc(entry.merchant)} · ${esc(entry.label)}</small><span class="mode">${mode === 'sandbox' ? 'PayPal sandbox' : 'demo'}</span></div><span class="amt">${fmt(entry.amount)}</span>`;
  add(li);
}

function planCard({ items }) {
  let card = state.cards.plan;
  if (!card) {
    card = el('li', 'card plan');
    state.cards.plan = card;
  }
  card.innerHTML = `<header><span class="avatar" style="background:var(--accent)">✦</span><div><b>Your plan</b><small>Updated live</small></div></header><ol>${items
    .map((i) => `<li><span>${esc(i.what)}${i.merchant ? ` · <span style="color:var(--ink-3)">${esc(i.merchant)}</span>` : ''}${i.when ? ` · ${esc(i.when)}` : ''}</span><em class="${i.status}">${i.status.replace('_', ' ')}</em></li>`)
    .join('')}</ol>`;
  add(card); // moves the plan to the bottom so it stays in view
}

function sharesCard({ label, per, links }) {
  const li = el('li', 'card');
  li.innerHTML = `<header><span class="avatar" style="background:#7b61ff">👥</span><div><b>Split sent with PayPal</b><small>${esc(label)} · ${fmt(per)} each</small></div></header><p style="margin:10px 0 0;font-size:14px;color:var(--ink-2)">${links.map((l) => esc(l.friend)).join(', ')}</p>`;
  add(li);
}

function envelope(e) {
  state.currency = e.currency;
  $('#envRemaining').textContent = fmt(e.remaining);
  $('#envSpent').textContent = fmt(e.spent);
  $('#envHeld').textContent = fmt(e.held);
  $('#envLeft').textContent = fmt(e.remaining);
  $('#envPurpose').textContent = fmt(e.total) + ' mandate';
  const p = (v) => (100 * v) / (e.total || 1);
  $('.env-bar .spent').style.width = p(e.spent) + '%';
  $('.env-bar .held').style.width = p(e.held) + '%';
  $('.ring-spent').style.strokeDasharray = `${(p(e.spent) * 94.2) / 100} 94.2`;
  $('.ring-held').style.strokeDasharray = `0 ${(p(e.spent) * 94.2) / 100} ${(p(e.held) * 94.2) / 100} 94.2`;
}

// ---------- Approval sheet: hold to approve ----------
let pending = null;
function openSheet(a) {
  pending = a;
  $('#sheetMerchant').textContent = `Pay ${a.merchant} (via Mandat)`;
  $('#sheetLines').innerHTML = `<div><span>${esc(a.label)}</span><span>${fmt(a.amount)}</span></div>${a.offer_total ? `<div><span>Booking total</span><span>${fmt(a.offer_total)}</span></div>` : ''}`;
  $('#sheetAmount').textContent = fmt(a.amount);
  $('#sheetFine').textContent = 'Held with PayPal, not charged until the merchant confirms. Cancel anytime and it returns to your mandate.';
  const btn = $('#sheetApprove');
  btn.className = 'hold-btn';
  btn.querySelector('.label').textContent = 'Hold to approve';
  $('#scrim').hidden = false;
  $('#sheet').hidden = false;
}
function closeSheet() {
  $('#scrim').hidden = true;
  $('#sheet').hidden = true;
  pending = null;
}
(() => {
  const btn = $('#sheetApprove');
  let timer = null;
  const start = (e) => {
    e.preventDefault();
    if (!pending) return;
    btn.classList.add('holding');
    timer = setTimeout(async () => {
      btn.classList.add('done');
      btn.querySelector('.label').textContent = 'Approved';
      const id = pending.id;
      setTimeout(closeSheet, 500);
      await post(`/api/sessions/${state.session}/approvals/${id}`, { approved: true });
    }, 900);
  };
  const cancel = () => {
    clearTimeout(timer);
    if (!btn.classList.contains('done')) btn.classList.remove('holding');
  };
  btn.addEventListener('pointerdown', start);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => btn.addEventListener(t, cancel));
  $('#sheetDecline').addEventListener('click', async () => {
    if (!pending) return;
    const id = pending.id;
    closeSheet();
    await post(`/api/sessions/${state.session}/approvals/${id}`, { approved: false });
  });
})();

// ---------- Voice: talk to it like a person ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function listen(onText, button) {
  if (!SR) return alert('Voice input is not supported in this browser — type instead.');
  stopSpeaking();
  rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = '';
  rec.onresult = (e) => {
    finalText = Array.from(e.results).map((r) => r[0].transcript).join(' ');
    if (button === 'orb') $('#sayText').value = finalText;
  };
  rec.onend = () => {
    state.listening = false;
    orbState('idle');
    button === 'mic' ? $('#dictate').classList.remove('listening') : null;
    if (finalText.trim()) onText(finalText.trim());
  };
  state.listening = true;
  orbState('listening');
  if (button === 'mic') $('#dictate').classList.add('listening');
  rec.start();
}
$('#orb').addEventListener('click', () => {
  if (state.listening) return rec?.stop();
  listen((t) => {
    $('#sayText').value = '';
    send(t);
  }, 'orb');
});
$('#dictate').addEventListener('click', () => listen((t) => ($('#intent').value = t), 'mic'));

function speak(text) {
  if (!state.voiceOn || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  const lang = (navigator.language || 'en').slice(0, 2);
  u.voice = voices.find((v) => v.lang.startsWith(lang) && /premium|enhanced|siri/i.test(v.name)) || voices.find((v) => v.lang.startsWith(lang)) || null;
  u.rate = 1.02;
  u.onstart = () => { state.speaking = true; orbState('speaking'); };
  u.onend = () => { state.speaking = false; orbState('idle'); };
  speechSynthesis.speak(u);
}
function stopSpeaking() {
  if (window.speechSynthesis) speechSynthesis.cancel();
  state.speaking = false;
}
function orbState(s) {
  const o = $('#orb');
  o.classList.remove('listening', 'speaking', 'thinking');
  if (s !== 'idle') o.classList.add(s);
}

// ---------- helpers ----------
function add(node) {
  feed.append(node);
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
}
function step(text) { return el('li', 'step', text); }
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
