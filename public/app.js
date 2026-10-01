// Mandat — client. Welcome (PayPal login) → mandate → missions → a mission live; settings.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = { me: null, mission: null, es: null, currency: 'EUR', speaking: false, listening: false, cards: {}, verified: {}, photo: null };
const fmt = (v) => new Intl.NumberFormat(navigator.language || 'en-US', { style: 'currency', currency: state.currency, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v || 0);
const PLURAL = { bakery: 'bakeries', florist: 'florists', restaurant: 'restaurants', hotel: 'hotels', bar: 'bars', cafe: 'cafés', hairdresser: 'hair salons', cinema: 'cinemas' };
const many = (c) => PLURAL[c] || c + 's';

// ---------- routing ----------
const VIEWS = ['welcome', 'mandate', 'home', 'live', 'settings'];
function show(view) {
  for (const v of VIEWS) $('#' + v).hidden = v !== view;
  $('#tabbar').hidden = !['home', 'settings'].includes(view);
  $('#composer').hidden = view !== 'live';
  $('#back').hidden = view !== 'live';
  $('#envChip').hidden = view !== 'live';
  $('#stopMission').hidden = view !== 'live';
  $('#newMission').hidden = view !== 'home';
  $('.brand-mark').hidden = view === 'live';
  if (view !== 'live') $('#topTitle').textContent = 'Mandat';
  $$('#tabbar button').forEach((b) => b.toggleAttribute('aria-current', b.dataset.tab === view));
  window.scrollTo({ top: 0 });
}

async function boot() {
  const r = await get('/api/me');
  state.me = r.user;
  state.paypalMode = r.paypalMode;
  $('#demoNote').textContent = r.paypalMode === 'sandbox' ? 'PayPal sandbox — no real money moves.' : 'Demo mode — PayPal sandbox keys not configured yet.';
  const p = new URLSearchParams(location.search);
  history.replaceState(null, '', '/');
  if (!state.me.paypal.connected) return show('welcome');
  if (!state.me.paypal.mandate) return mandateView();
  renderHome(r.missions);
  const open = p.get('mission');
  if (open) openMission(open);
  else show('home');
}

// ---------- mandate ----------
let mAutonomy = 'balanced';
function mandateView() {
  $('#mCap').value = state.me.rules.monthlyCap;
  setSeg('#mAutonomy', state.me.rules.autonomy);
  mAutonomy = state.me.rules.autonomy;
  $('#mAutonomyHelp').textContent = state.me.autonomyLevels[mAutonomy].help;
  show('mandate');
}
segmented('#mAutonomy', (v) => {
  mAutonomy = v;
  $('#mAutonomyHelp').textContent = state.me.autonomyLevels[v].help;
});
$('#signMandate').addEventListener('click', async () => {
  await post('/api/me', { rules: { autonomy: mAutonomy, monthlyCap: Number($('#mCap').value) } });
  const setup = await post('/api/me/mandate', {});
  location.href = setup.approveUrl;
});

// ---------- home ----------
function renderHome(missions) {
  const name = (state.me.profile.name || state.me.paypal.payerName || '').split(' ')[0];
  $('#hello').textContent = name ? `Hi ${name} — what can I take off your plate?` : 'What can I take off your plate?';
  $('#stoppedBanner').hidden = !state.me.frozen;
  const ol = $('#missions');
  ol.innerHTML = '';
  $('#empty').hidden = missions.length > 0;
  for (const m of missions) ol.append(missionRow(m));
}
const STATUS = { needs_you: 'Needs you', working: 'Working', done: 'Done', stopped: 'Stopped', new: 'New' };
function missionRow(m) {
  const li = el('li', 'mission');
  li.dataset.id = m.id;
  const p = (v) => (100 * v) / (m.total || 1);
  li.innerHTML = `<span class="emoji">${esc(m.emoji)}</span><div class="info"><b>${esc(m.title)}</b><small>${fmtC(m.remaining, m.currency)} left of ${fmtC(m.total, m.currency)}${m.progress ? ` · ${m.progress.done}/${m.progress.of} booked` : ''}</small><div class="bar"><i class="s" style="width:${p(m.spent)}%"></i><i class="h" style="width:${p(m.held)}%"></i></div></div><span class="badge ${m.status}">${STATUS[m.status]}</span>`;
  li.addEventListener('click', () => openMission(m.id));
  return li;
}
async function refreshHome() {
  const r = await get('/api/me');
  state.me = r.user;
  renderHome(r.missions);
}
$$('#tabbar button').forEach((b) => b.addEventListener('click', () => (b.dataset.tab === 'home' ? (refreshHome(), show('home')) : (renderSettings(), show('settings')))));
$('#resumeAll').addEventListener('click', async () => {
  state.me = (await post('/api/me/stop', { stopped: false })).user;
  refreshHome();
});

// ---------- new mission sheet ----------
const EMOJI = [[/spain|españa|espagne|travel|trip|voyage|vacation/i, '🧳'], [/birthday|anniversaire/i, '🎂'], [/dinner|restaurant|dîner/i, '🍽️'], [/hair|coiff/i, '💇'], [/concert|ticket|billet/i, '🎟️'], [/flower|fleur/i, '💐'], [/hotel|hôtel/i, '🛎️']];
let nmEmoji = null;
function openNew(text = '', budget = 400, emoji = null) {
  $('#nmIntent').value = text;
  $('#nmBudget').value = budget;
  nmEmoji = emoji;
  state.photo = null;
  $('#nmPreview').hidden = true;
  const lvl = state.me.rules.autonomy;
  $('#nmRule').textContent = lvl === 'autopilot' ? 'Autopilot: it will book and hold deposits on its own inside this budget.' : lvl === 'careful' ? 'Careful: it will ask you before every payment.' : `Balanced: it asks you before any payment above ${fmtC(state.me.rules.approveAbove)}.`;
  $('#nmScrim').hidden = false;
  $('#nmSheet').hidden = false;
  setTimeout(() => $('#nmIntent').focus(), 300);
}
function closeNew() {
  $('#nmScrim').hidden = true;
  $('#nmSheet').hidden = true;
}
$('#newMission').addEventListener('click', () => openNew());
$('#nmCancel').addEventListener('click', closeNew);
$('#nmScrim').addEventListener('click', closeNew);
$$('.suggest').forEach((b) => b.addEventListener('click', () => openNew(b.dataset.t, Number(b.dataset.b), b.dataset.e)));
$('#nmMic').addEventListener('click', () => listen((t) => ($('#nmIntent').value = t), $('#nmMic')));
$('#nmPhoto').addEventListener('click', () => pickPhoto((url) => {
  state.photo = url;
  $('#nmPreview').src = url;
  $('#nmPreview').hidden = false;
}));
$('#nmStart').addEventListener('click', async () => {
  const intent = $('#nmIntent').value.trim() || (state.photo ? '' : $('#nmIntent').placeholder);
  const budget = Number($('#nmBudget').value);
  const emoji = nmEmoji || EMOJI.find(([re]) => re.test(intent))?.[1] || '✦';
  $('#nmStart').disabled = true;
  try {
    const location = await locate();
    const r = await post('/api/missions', { intent, budget, emoji, location, image: state.photo });
    closeNew();
    openMission(r.id);
  } catch (e) {
    alert(e.message);
  } finally {
    $('#nmStart').disabled = false;
  }
});

// ---------- a mission, live ----------
async function openMission(id) {
  if (state.es) state.es.close();
  Object.assign(state, { mission: id, cards: {}, verified: {} });
  $('#feed').innerHTML = '';
  const r = await get(`/api/missions/${id}`);
  $('#topTitle').textContent = r.summary.title;
  $('#stopMission').classList.toggle('on', r.summary.status === 'stopped');
  envelope(r.envelope);
  show('live');
  state.es = new EventSource(`/api/missions/${id}/events`);
  state.es.onmessage = (m) => handle(JSON.parse(m.data));
}
$('#back').addEventListener('click', () => {
  if (state.es) state.es.close();
  state.mission = null;
  stopSpeaking();
  refreshHome();
  show('home');
});
$('#stopMission').addEventListener('click', async () => {
  const on = !$('#stopMission').classList.contains('on');
  await post(`/api/missions/${state.mission}/stop`, { stopped: on });
  $('#stopMission').classList.toggle('on', on);
});

$('#say').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#sayText').value.trim();
  if (!t) return;
  $('#sayText').value = '';
  send(t);
});
$('#photoBtn').addEventListener('click', () => pickPhoto((url) => send($('#sayText').value.trim(), url).then(() => ($('#sayText').value = ''))));
function send(text, image) {
  stopSpeaking();
  return post(`/api/missions/${state.mission}/messages`, { text, image });
}

function handle({ type, data }) {
  switch (type) {
    case 'user': {
      const li = el('li', 'say user' + (data.image ? ' photo-bubble' : ''), data.text || '');
      if (data.image) li.prepend(el('span', '', '📷 Photo '));
      return add(li);
    }
    case 'photo_read': return add(el('li', 'seen', data.summary));
    case 'say': add(el('li', 'say', data.text)); return speak(data.text);
    case 'busy': return orbState(data.on ? 'thinking' : state.speaking ? 'speaking' : 'idle');
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
    case 'stopped': return add(step(data.stopped ? 'Stopped — no payment will be made until you resume.' : 'Resumed.'));
    case 'error': return add(step('Something went wrong: ' + data.message));
  }
}

const TOOL_LABEL = {
  find_real_places: (a) => `Looking for real ${many(a.category)} nearby`,
  find_network_merchants: (a) => `Checking ${many(a.category)} I can book and pay`,
  cancel_hold: () => 'Releasing a hold',
  split_bill: () => 'Preparing PayPal links for your friends',
};
function toolStep({ name, args }) {
  const label = TOOL_LABEL[name]?.(args);
  if (label) add(step(label));
}
function placesCard({ category, places }) {
  if (!places?.length) return;
  const li = el('li', 'card places');
  li.innerHTML = `<header><span class="avatar" style="background:#19a463">⌖</span><div><b>Real ${many(category)} near you</b><small>OpenStreetMap</small></div></header><ul>${places.slice(0, 4)
    .map((p) => `<li>${esc(p.name)} <span>· ${p.distance} m${p.openingHours ? ' · ' + esc(p.openingHours.slice(0, 28)) : ''}</span></li>`).join('')}</ul>`;
  add(li);
}
function verifiedMark({ merchant_id, name, ok }) {
  state.verified[merchant_id] = ok;
  const card = state.cards['n:' + merchant_id];
  if (card) card.querySelector('.shield').hidden = !ok;
  add(step(`${name} — identity ${ok ? 'verified' : 'could not be verified'}`));
}
function negotiation({ merchant_id, name, from, text, offer }) {
  let card = state.cards['n:' + merchant_id];
  if (!card) {
    card = $('#tpl-negotiation').content.firstElementChild.cloneNode(true);
    card.querySelector('.name').textContent = name;
    card.querySelector('.avatar').textContent = name[0];
    card.querySelector('.shield').hidden = !state.verified[merchant_id];
    state.cards['n:' + merchant_id] = card;
    add(card);
  }
  card.querySelector('.bubbles').append(el('li', from, text));
  if (offer) {
    const o = card.querySelector('.offer');
    o.hidden = false;
    o.innerHTML = [offer.slot && `<span>${esc(offer.slot)}</span>`, offer.discount ? `<span>−${fmt(offer.discount)}</span>` : '', offer.deposit ? `<span>deposit ${fmt(offer.deposit)}</span>` : '', offer.total ? `<span class="total">${fmt(offer.total)}</span>` : ''].filter(Boolean).join('');
  }
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
  if (!card) card = state.cards.plan = el('li', 'card plan');
  card.innerHTML = `<header><span class="avatar" style="background:var(--accent)">✦</span><div><b>Your plan</b><small>Updated live</small></div></header><ol>${items
    .map((i) => `<li><span>${esc(i.what)}${i.merchant ? ` · <span style="color:var(--ink-3)">${esc(i.merchant)}</span>` : ''}${i.when ? ` · ${esc(i.when)}` : ''}</span><em class="${i.status}">${i.status.replace('_', ' ')}</em></li>`)
    .join('')}</ol>`;
  add(card);
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
  $('#envPurpose').textContent = fmt(e.total);
  const p = (v) => (100 * v) / (e.total || 1);
  $('.env-bar .spent').style.width = p(e.spent) + '%';
  $('.env-bar .held').style.width = p(e.held) + '%';
  $('.ring-spent').style.strokeDasharray = `${(p(e.spent) * 94.2) / 100} 94.2`;
  $('.ring-held').style.strokeDasharray = `0 ${(p(e.spent) * 94.2) / 100} ${(p(e.held) * 94.2) / 100} 94.2`;
}

// ---------- approval sheet: hold to approve ----------
let pending = null;
function openSheet(a) {
  if (a.status && a.status !== 'pending') return;
  pending = a;
  $('#sheetMerchant').textContent = `Pay ${a.merchant} (via Mandat)`;
  $('#sheetLines').innerHTML = `<div><span>${esc(a.label)}</span><span>${fmt(a.amount)}</span></div>${a.offer_total ? `<div><span>Booking total</span><span>${fmt(a.offer_total)}</span></div>` : ''}`;
  $('#sheetAmount').textContent = fmt(a.amount);
  $('#sheetFine').textContent = 'Held with PayPal, not charged until the merchant confirms. Cancel anytime and it returns to your mission budget.';
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
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!pending) return;
    btn.classList.add('holding');
    timer = setTimeout(async () => {
      btn.classList.add('done');
      btn.querySelector('.label').textContent = 'Approved';
      const id = pending.id;
      setTimeout(closeSheet, 500);
      await post(`/api/missions/${state.mission}/approvals/${id}`, { approved: true });
    }, 900);
  });
  const cancel = () => {
    clearTimeout(timer);
    if (!btn.classList.contains('done')) btn.classList.remove('holding');
  };
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => btn.addEventListener(t, cancel));
  $('#sheetDecline').addEventListener('click', async () => {
    if (!pending) return;
    const id = pending.id;
    closeSheet();
    await post(`/api/missions/${state.mission}/approvals/${id}`, { approved: false });
  });
})();

// ---------- settings ----------
let sAutonomy = 'balanced';
function renderSettings() {
  const u = state.me;
  $('#sPayer').textContent = u.paypal.payerName || u.profile.name || 'PayPal account';
  $('#sPayerMail').textContent = u.paypal.payerEmail || (state.paypalMode === 'sandbox' ? '' : 'Demo account');
  $('#sVerified').hidden = !u.paypal.verified;
  $('#sMandate').textContent = u.paypal.mandate ? `Active since ${new Date(u.paypal.mandate.signedAt).toLocaleDateString()} · ${u.paypal.mandate.mode === 'sandbox' ? 'PayPal sandbox' : 'demo'}` : 'Not signed';
  sAutonomy = u.rules.autonomy;
  setSeg('#sAutonomy', sAutonomy);
  $('#sAutonomyHelp').textContent = u.autonomyLevels[sAutonomy].help;
  $('#sApproveRow').hidden = sAutonomy !== 'balanced';
  $('#sApprove').value = u.rules.approveAbove;
  $('#sDaily').value = u.rules.dailyCap;
  $('#sMonthly').value = u.rules.monthlyCap;
  $('#sStop').checked = u.frozen;
  $('#pName').value = u.profile.name;
  $('#pEmail').value = u.profile.email;
  $('#pPhone').value = u.profile.phone;
  $('#pHome').value = u.profile.home?.label || '';
  $('#pDiet').value = u.profile.diet;
  $('#pPrefs').value = u.profile.preferences;
  $('#sVoice').checked = u.voice.on;
  $('#sKnows').textContent = u.knows || 'Nothing yet.';
  renderPeople(u.profile.people);
}
function renderPeople(people) {
  const g = $('#people');
  g.innerHTML = '';
  if (!people.length) g.innerHTML = '<div class="person"><span style="color:var(--ink-3);font-size:15px">Nobody yet</span></div>';
  people.forEach((p, i) => {
    const row = el('div', 'person');
    row.innerHTML = `<input value="${esc(p.name)}" placeholder="Name" data-k="name"><input value="${esc(p.contact)}" placeholder="Email or phone" data-k="contact"><button aria-label="Remove">−</button>`;
    row.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', () => {
      people[i][inp.dataset.k] = inp.value;
      saveProfile({ people });
    }));
    row.querySelector('button').addEventListener('click', () => {
      people.splice(i, 1);
      saveProfile({ people });
      renderPeople(people);
    });
    g.append(row);
  });
}
$('#addPerson').addEventListener('click', () => {
  const people = state.me.profile.people;
  people.push({ name: 'New person', contact: '' });
  renderPeople(people);
  saveProfile({ people });
});
async function saveProfile(profile) {
  state.me = (await post('/api/me', { profile })).user;
  $('#sKnows').textContent = state.me.knows || 'Nothing yet.';
}
async function saveRules(rules) {
  state.me = (await post('/api/me', { rules })).user;
}
for (const [id, key] of [['#pName', 'name'], ['#pEmail', 'email'], ['#pPhone', 'phone'], ['#pDiet', 'diet'], ['#pPrefs', 'preferences']]) {
  $(id).addEventListener('change', () => saveProfile({ [key]: $(id).value }));
}
$('#pHome').addEventListener('change', async () => {
  const q = $('#pHome').value.trim();
  if (!q) return saveProfile({ home: null });
  try {
    const g = await get('/api/geocode?q=' + encodeURIComponent(q));
    saveProfile({ home: { label: q, lat: g.lat, lon: g.lon } });
  } catch {
    saveProfile({ home: { label: q } });
  }
});
segmented('#sAutonomy', (v) => {
  sAutonomy = v;
  $('#sAutonomyHelp').textContent = state.me.autonomyLevels[v].help;
  $('#sApproveRow').hidden = v !== 'balanced';
  saveRules({ autonomy: v });
});
for (const [id, key] of [['#sApprove', 'approveAbove'], ['#sDaily', 'dailyCap'], ['#sMonthly', 'monthlyCap']]) {
  $(id).addEventListener('change', () => saveRules({ [key]: Number($(id).value) }));
}
$('#sStop').addEventListener('change', async () => {
  state.me = (await post('/api/me/stop', { stopped: $('#sStop').checked })).user;
});
$('#sVoice').addEventListener('change', async () => {
  state.me = (await post('/api/me', { voice: { on: $('#sVoice').checked } })).user;
});
$('#sForget').addEventListener('click', async () => {
  if (!confirm('Forget everything Mandat knows about you? Your PayPal connection and missions stay.')) return;
  state.me = (await post('/api/me/forget', {})).user;
  renderSettings();
});
$('#sRevoke').addEventListener('click', async () => {
  if (!confirm('Revoke the PayPal mandate? Your agent will not be able to hold any deposit.')) return;
  state.me = (await post('/api/me/mandate/revoke', {})).user;
  mandateView();
});
$('#sLocBtn').addEventListener('click', async () => {
  const l = await locate();
  $('#sLoc').textContent = l ? 'Allowed — used to search around you' : 'Not allowed — your usual address is used';
});

// ---------- photos ----------
function pickPhoto(onReady) {
  const input = $('#photoInput');
  input.value = '';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (f) onReady(await shrink(f));
  };
  input.click();
}
// Downscale to 1280 px JPEG: plenty for reading a menu or a poster, small enough to send.
function shrink(file) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.82));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });
}

// ---------- voice ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function listen(onText, button) {
  if (!SR) return alert('Voice input is not supported in this browser — type instead.');
  stopSpeaking();
  rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  let finalText = '';
  rec.onresult = (e) => {
    finalText = Array.from(e.results).map((r) => r[0].transcript).join(' ');
    if (!button) $('#sayText').value = finalText;
  };
  rec.onend = () => {
    state.listening = false;
    orbState('idle');
    button?.classList.remove('listening');
    if (finalText.trim()) onText(finalText.trim());
  };
  state.listening = true;
  if (button) button.classList.add('listening');
  else orbState('listening');
  rec.start();
}
$('#orb').addEventListener('click', () => {
  if (state.listening) return rec?.stop();
  listen((t) => {
    $('#sayText').value = '';
    send(t);
  });
});
function speak(text) {
  if (!state.me?.voice?.on || !window.speechSynthesis) return;
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
function segmented(sel, onPick) {
  $$(sel + ' button').forEach((b) => b.addEventListener('click', () => {
    setSeg(sel, b.dataset.v);
    onPick(b.dataset.v);
  }));
}
function setSeg(sel, v) {
  $$(sel + ' button').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.v === v)));
}
for (const b of $$('.stepper button')) {
  b.addEventListener('click', () => {
    const i = b.parentElement.querySelector('input');
    i.value = Math.max(0, Math.min(20000, (Number(i.value) || 0) + Number(b.dataset.step)));
    i.dispatchEvent(new Event('change'));
  });
}
function fmtC(v, cur = 'EUR') {
  return new Intl.NumberFormat(navigator.language || 'en-US', { style: 'currency', currency: cur, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v || 0);
}
function add(node) {
  $('#feed').append(node);
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
async function get(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}

boot();
