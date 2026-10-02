// Mandat — client. Welcome (PayPal login) → mandate → missions → a mission live; settings.
import { t, tn, lang, locale, applyI18n, setLang, chosenLang } from '/i18n.js';
import { budgetFromText } from '/budget.mjs'; // same reader as the server: "700 €", "40 € each for 4", "budget 250"…
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = { me: null, mission: null, es: null, currency: 'EUR', speaking: false, listening: false, cards: {}, verified: {}, photo: null, voiceTurn: false, live: false };
const fmt = (v) => new Intl.NumberFormat(locale(), { style: 'currency', currency: state.currency, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v || 0);
const PLURAL = { bakery: 'bakeries', florist: 'florists', restaurant: 'restaurants', hotel: 'hotels', bar: 'bars', cafe: 'cafés', hairdresser: 'hair salons', cinema: 'cinemas' };
const many = (c) => t(PLURAL[c] || c + 's');

// ---------- routing ----------
const VIEWS = ['welcome', 'onboard', 'mandate', 'home', 'live', 'activity', 'settings'];
function show(view) {
  document.body.classList.toggle('on-welcome', view === 'welcome' || view === 'onboard');
  if (view === 'welcome') playStory(); else stopStory();
  for (const v of VIEWS) $('#' + v).hidden = v !== view;
  $('#tabbar').hidden = !['home', 'activity', 'settings'].includes(view);
  $('#composer').hidden = view !== 'live';
  $('#bottomFade').hidden = view !== 'live';
  $('#tray').hidden = view !== 'live' || !state.attach?.length;
  $('#back').hidden = view !== 'live';
  $('#topBudget').hidden = view !== 'live';
  $('#topbar').classList.toggle('has-budget', view === 'live');
  $('#topbar').classList.remove('expanded');
  $('#topSub').hidden = view !== 'live';
  $('#stopMission').hidden = view !== 'live';
  $('#newMission').hidden = view !== 'home';
  $('.brand-mark').hidden = view === 'live';
  if (view !== 'live') { $('#topTitle').textContent = 'Mandat'; setTopEmoji(''); }
  $$('#tabbar button').forEach((b) => (b.dataset.tab === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  window.scrollTo({ top: 0 });
  if (view === 'home') requestAnimationFrame(placePill);
  requestAnimationFrame(() => placeLens());
}

// Welcome story: a real mission plays out in a few seconds — ask, compare, negotiate, hold with PayPal, all set.
applyI18n();
let storyTimer = null;
const STORY_ICON = {
  found: '<path d="M10.5 4a6.5 6.5 0 0 1 5.2 10.4l4.4 4.4-1.4 1.4-4.4-4.4A6.5 6.5 0 1 1 10.5 4Zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z"/>',
  deal: '<path d="M11.6 3H20v8.4l-9.3 9.3a1.5 1.5 0 0 1-2.1 0l-6.3-6.3a1.5 1.5 0 0 1 0-2.1L11.6 3Zm4.9 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>',
  hold: '<path d="M8.3 20.5H5.4L7.7 5h5.1c3.2 0 4.9 1.6 4.5 4.3-.5 3-2.6 4.4-5.6 4.4H9.4l-1.1 6.8Zm1.4-9.1h1.7c1.5 0 2.5-.6 2.7-2 .2-1.3-.6-1.9-2-1.9h-1.6l-.8 3.9Z"/>',
  done: '<path d="m9.6 16.2-4-4L4.2 13.6l5.4 5.4L20 8.6l-1.4-1.4z"/>',
};
function playStory() {
  stopStory();
  const list = $('#storySteps');
  const money = (v) => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'EUR', maximumFractionDigits: v % 1 ? 2 : 0 }).format(v);
  const budget = (held) => {
    $('#sbHeld').style.width = (held / 160) * 100 + '%';
    $('#sbText').textContent = t('{held} held of {total}', { held: money(held), total: money(160) });
  };
  const steps = [
    () => list.append(el('li', 'st-ask', t('Dinner for 4 on Saturday, €160 max'))),
    () => list.append(storyRow('found', t('3 restaurants compared'), t('Lumière · Paris 11 · ★ 4.6'))),
    () => list.append(storyRow('deal', t('Negotiated −10% for the group'), t('€144 instead of €160'))),
    () => { list.append(storyRow('hold', t('Deposit held with PayPal'), t('Paid only when Lumière confirms'))); budget(28.8); },
    () => list.append(storyRow('done', t('All set · Sat 7:30 pm'), t('Reminder Friday 8 pm · in your calendar'))),
  ];
  const reset = () => { list.innerHTML = ''; budget(0); $('#story').classList.remove('fading'); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { reset(); steps.forEach((f) => f()); return; }
  let i = 0;
  reset();
  const tick = () => {
    if (i < steps.length) { steps[i++](); storyTimer = setTimeout(tick, i === 1 ? 900 : 1100); return; }
    storyTimer = setTimeout(() => { $('#story').classList.add('fading'); storyTimer = setTimeout(() => { reset(); i = 0; tick(); }, 450); }, 3200);
  };
  storyTimer = setTimeout(tick, 500);
}
function storyRow(kind, title, sub) {
  const li = el('li', 'st-row st-' + kind);
  li.innerHTML = `<span class="st-ic"><svg viewBox="0 0 24 24">${STORY_ICON[kind]}</svg></span><div><b>${esc(title)}</b><small>${esc(sub)}</small></div>`;
  return li;
}
function stopStory() { clearTimeout(storyTimer); storyTimer = null; }

// Like a native app, the screen never pinch-zooms (Safari gesture events); the photo viewer keeps its own zoom.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => { if (!e.target.closest?.('#lightbox')) e.preventDefault(); }, { passive: false });
}
history.scrollRestoration = 'manual'; // every screen opens at its top
async function boot() {
  const r = await get('/api/me');
  state.me = r.user;
  state.paypalMode = r.paypalMode;
  $('#demoNote').textContent = r.paypalMode === 'sandbox' ? t('PayPal sandbox: no real money moves.') : t('Demo mode: PayPal sandbox keys are not set up yet.');
  const p = new URLSearchParams(location.search);
  history.replaceState(null, '', '/');
  if (!state.me.paypal.mandate) return p.get('mandate') === 'cancelled' ? mandateView() : show('welcome');
  if (!state.me.onboarded) return onboardView();
  renderHome(r.missions);
  navigator.serviceWorker?.register('/sw.js').catch(() => {});
  const open = p.get('mission');
  let back = null;
  try { back = JSON.parse(sessionStorage.getItem('mandat_return') || 'null'); sessionStorage.removeItem('mandat_return'); } catch {}
  restorePending();
  if (open) openMission(open);
  else if (back?.view === 'settings') { TABS.settings(); show('settings'); requestAnimationFrame(() => scrollTo({ top: back.y || 0 })); }
  else show('home');
}

// ---------- mandate (signing it is also the PayPal sign-in) ----------
$('#start').addEventListener('click', () => mandateView());
let mAutonomy = 'balanced';
function mandateView({ why = false } = {}) {
  $('#mandateWhy').hidden = !why;
  $('#mCap').value = state.me.rules.monthlyCap;
  setSeg('#mAutonomy', state.me.rules.autonomy);
  mAutonomy = state.me.rules.autonomy;
  $('#mAutonomyHelp').textContent = t(state.me.autonomyLevels[mAutonomy].help);
  show('mandate');
}
segmented('#mAutonomy', (v) => {
  mAutonomy = v;
  $('#mAutonomyHelp').textContent = t(state.me.autonomyLevels[v].help);
});
$('#signMandate').addEventListener('click', async () => {
  await post('/api/me', { rules: { autonomy: mAutonomy, monthlyCap: Number($('#mCap').value) } });
  const setup = await post('/api/me/mandate', {});
  location.href = setup.approveUrl;
});

// ---------- first run: where, what to avoid, what you like, notifications ----------
// One catalogue for the first run and for Settings: people tap, they do not type.
const DIET = ['Vegetarian', 'Vegan', 'Pescatarian', 'Halal', 'Kosher', 'No pork', 'No alcohol', 'Gluten-free', 'Lactose-free', 'Nut allergy', 'Peanut allergy', 'Seafood allergy', 'Egg allergy', 'Soy allergy'];
const TASTES = [
  { title: 'Atmosphere', items: ['Quiet places', 'Lively places', 'Terraces', 'Rooftops', 'Cosy', 'Romantic', 'Family-friendly', 'Good music'] },
  { title: 'Food', items: ['Local spots', 'Fine dining', 'Street food', 'French', 'Italian', 'Japanese', 'Lebanese', 'Indian', 'Mexican', 'Brunch', 'Early dinners', 'Late dinners'] },
  { title: 'Travel', items: ['Trains over planes', 'Central hotels', 'Boutique hotels', 'Hostels', 'Window seat', 'Walking distance'] },
  { title: 'Budget', items: ['Good value', 'Treat myself', 'Free cancellation'] },
];
const OB_DIET = DIET.slice(0, 10);
const OB_LIKES = ['Quiet places', 'Terraces', 'Local spots', 'Fine dining', 'Good value', 'Italian', 'Japanese', 'Trains over planes', 'Central hotels', 'Early dinners'];
let obStep = 0;
let obHomeSel = null; // the address picked from the suggestions or from the location
function obChips(box, labels, saved) {
  box.innerHTML = '';
  for (const l of labels) {
    const b = el('button', 'ob-chip' + (saved.toLowerCase().includes(t(l).toLowerCase()) ? ' on' : ''), t(l));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(b.classList.contains('on')));
    b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.classList.toggle('on'))));
    box.append(b);
  }
}
const obPicked = (box, more) => [...$$(box + ' .ob-chip.on')].map((b) => b.textContent).concat($(more).value.trim() ? [$(more).value.trim()] : []).join(', ');
function onboardView() {
  const p = state.me.profile;
  $('#obHome').value = p.home?.label || '';
  obHomeSel = p.home || null;
  obChips($('#obDiet'), OB_DIET, p.diet || '');
  obChips($('#obLikes'), OB_LIKES, p.preferences || '');
  obGo(0);
  show('onboard');
}
function obGo(i) {
  obStep = i;
  $$('.ob-step').forEach((s) => (s.hidden = Number(s.dataset.step) !== i));
  $$('.ob-progress i').forEach((d, k) => d.classList.toggle('on', k <= i));
  $('#obBack').classList.toggle('off', i === 0);
  $('#obNext').textContent = i === 3 ? t('Start') : t('Continue');
  if (i === 3) obPushState();
  window.scrollTo({ top: 0 });
}
function obPushState() {
  const why = pushSupport();
  const on = state.me.notifications > 0 && why === 'ok' && Notification.permission === 'granted';
  $('#obPush').classList.toggle('on', on);
  $('#obPush b').textContent = on ? t('Notifications on') : t('Turn on notifications');
  $('#obPushState').textContent = on ? t('On for this device') : why === 'install' ? t('Add Mandat to your Home Screen first, then turn them on here or in Settings.') : why === 'blocked' ? t('Blocked in your phone settings') : why === 'none' ? t('Not available in this browser') : t('You can turn them off anytime');
}
async function obSave(i) {
  const profile = {};
  const typed = $('#obHome').value.trim();
  if (i === 0 && typed) profile.home = obHomeSel?.label === typed ? obHomeSel : { label: typed };
  if (i === 1) profile.diet = obPicked('#obDiet', '#obDietMore');
  if (i === 2) profile.preferences = obPicked('#obLikes', '#obLikesMore');
  if (Object.keys(profile).length) state.me = (await post('/api/me', { profile })).user;
}
// A mission written before signing the mandate comes back in the box, ready to send.
function restorePending() {
  let text = '';
  try { text = localStorage.getItem('mandat_pending') || ''; localStorage.removeItem('mandat_pending'); } catch {}
  if (!text) return;
  $('#cText').value = text;
  onCompose();
}
// Back from the background: if the account changed on the server (demo reset), start again cleanly.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.me?.paypal?.mandate) return;
  try {
    const r = await get('/api/me');
    if (!r.user.paypal.mandate) { state.me = r.user; show('welcome'); }
  } catch {}
});
async function obFinish() {
  state.me = (await post('/api/me', { onboarded: true })).user;
  const r = await get('/api/me');
  renderHome(r.missions);
  restorePending();
  show('home');
}
$('#obNext').addEventListener('click', async () => {
  try { await obSave(obStep); } catch {}
  if (obStep < 3) obGo(obStep + 1); else obFinish();
});
$('#obBack').addEventListener('click', () => { if (obStep > 0) obGo(obStep - 1); });
$('#obSkip').addEventListener('click', () => (obStep < 3 ? obGo(obStep + 1) : obFinish()));
$('#obLocate').addEventListener('click', async () => {
  $('#obLocState').textContent = t('Locating…');
  const l = await locate();
  $('#obLocate').classList.toggle('on', !!l);
  if (!l) { $('#obLocState').textContent = t('Not allowed: type your usual address below'); return; }
  $('#obLocState').textContent = t('On, used to search around you');
  try {
    const a = await get(`/api/geo/reverse?lat=${l.lat}&lon=${l.lon}`);
    obHomeSel = { label: a.label, lat: l.lat, lon: l.lon };
    $('#obHome').value = a.label;
  } catch {}
});
$('#obHome').addEventListener('input', () => { obHomeSel = null; });
addressSuggest('#obHome', '#obHomeList', (h) => { obHomeSel = h; $('#obHome').value = h.label; });
$('#obPush').addEventListener('click', async () => {
  try { await enablePush(); } catch {}
  obPushState();
});

// ---------- home ----------
// ---------- home: one place to ask, then missions sorted by what needs you ----------
const IDEAS = [
  { e: '🧳', t: 'Weekend away', d: 'Hotel, train and a plan', b: 600, q: 'A weekend in Lisbon for two in November, leaving from Paris. A nice hotel near the center and one good dinner.' },
  { e: '🎂', t: 'Birthday evening', d: 'Table, cake, flowers', b: 300, q: "My partner's birthday this Saturday: dinner for 6 around 8pm near me, a cake and flowers." },
  { e: '🧾', t: 'Split a bill', d: 'Everyone pays their share', b: 150, q: 'Dinner came to 128 euros and I paid. Split it with Sam, Lina and Tom.' },
  { e: '🔧', t: 'Get something fixed', d: 'Snap a photo, done', b: 80, q: 'My bike has a flat tyre. Find a repair shop near me that can fix it today.' },
  { e: '💐', t: 'Send flowers', d: 'Delivered with a note', b: 70, q: 'Flowers delivered to my mum on Sunday morning, something cheerful, with a short note from me.' },
  { e: '🇪🇸', t: 'Two weeks in Spain', d: 'Trains, stays, budget kept', b: 700, q: 'Two weeks in Spain in October, I leave from Paris. 700 euros all in.' },
];
const EMOJI = [[/wedding|mariage|boda/i, '💍'], [/birthday|anniversaire/i, '🎂'], [/flight|plane|avion/i, '✈️'], [/train|tren/i, '🚆'], [/spain|españa|espagne|lisbon|travel|trip|voyage|vacation|weekend/i, '🧳'], [/hotel|hôtel/i, '🛎️'], [/sushi/i, '🍣'], [/pizza/i, '🍕'], [/coffee|café|brunch/i, '☕'], [/cake|gâteau|bakery|boulanger/i, '🥐'], [/dinner|lunch|restaurant|dîner|table/i, '🍽️'], [/split|share|bill|addition/i, '🧾'], [/flower|fleur/i, '💐'], [/gift|cadeau/i, '🎁'], [/party|fête/i, '🎉'], [/concert|festival/i, '🎵'], [/cinema|cinéma|movie/i, '🎬'], [/ticket|billet|theatre|théâtre/i, '🎟️'], [/repair|fix|tyre|tire|répar/i, '🔧'], [/bike|vélo/i, '🚲'], [/hair|coiff/i, '💇'], [/spa|massage/i, '💆'], [/doctor|médecin|dentist/i, '🩺'], [/dog|chien|cat|chat|pet/i, '🐾'], [/move|déménag/i, '📦'], [/clean|ménage/i, '🧹']];
// The budget is optional: say it in your message, set it in the pill, or let Mandat stay under your daily limit.
const compose = { budget: null, suggested: null, auto: false, touched: false, emoji: null, photos: [], voice: false };

// Ideas: tapping one fills the box — it never starts anything by itself.
for (const i of IDEAS) {
  const b = el('button', 'idea');
  b.type = 'button';
  b.innerHTML = `<span aria-hidden="true">${i.e}</span>${esc(t(i.t))}`;
  b.title = t(i.d);
  b.addEventListener('click', () => {
    const q = t(i.q);
    $('#cText').value = q;
    compose.emoji = i.e;
    compose.suggested = i.b;
    setBudget(i.b, { auto: false, touched: false }); // an amount you then type still wins
    onCompose();
    $('#cText').focus();
    $('#cText').setSelectionRange(q.length, q.length);
  });
  $('#ideas').append(b);
}

// A rotating example in the empty box, typed in softly.
const HINTS = ['Book a table for 4 tonight, around 40 € each…', 'Two weeks in Spain, 700 € all in…', 'Get my bike fixed today…', 'Split last night’s dinner with Sam and Lina…'].map((h) => t(h));
let hintI = 0, hintTimer;
function typeHint() {
  const box = $('#cText');
  if (box.value || document.activeElement === box) return (box.placeholder = t('Say what you need and what you can spend…'));
  const h = HINTS[hintI++ % HINTS.length];
  let n = 0;
  clearInterval(hintTimer);
  hintTimer = setInterval(() => {
    box.placeholder = h.slice(0, ++n);
    if (n >= h.length) clearInterval(hintTimer);
  }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 28);
}
setInterval(typeHint, 4200);

function setBudget(v, { auto = false, touched = compose.touched } = {}) {
  compose.budget = v || null;
  compose.auto = auto;
  compose.touched = touched;
  $('#cBudget').textContent = v ? fmtC(v) : t('Optional');
  $('#cBudgetBtn').classList.toggle('unset', !v);
  $('#cBudgetAuto').hidden = !auto;
  $('#cBudgetIn').value = v || '';
  $$('#cChips button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === v));
  if (state.me && !$('#cRule').classList.contains('error')) $('#cRule').textContent = ruleText();
}
function onCompose() {
  const text = $('#cText').value;
  const found = budgetFromText(text)?.amount;
  if (!compose.touched) {
    if (found) { if (found !== compose.budget || !compose.auto) setBudget(found, { auto: true, touched: false }); }
    else if (compose.auto) setBudget(compose.suggested, { auto: false, touched: false }); // the amount was deleted
  }
  // One button, as in a mission: the voice orb while empty, the send arrow as soon as there is something.
  const has = !!text.trim() || compose.photos.length > 0;
  $('#compose').classList.toggle('has-text', has);
  $('#cGo').setAttribute('aria-label', has ? t('Start mission') : t('Talk to Mandat'));
  $('#cText').style.height = 'auto';
  $('#cText').style.height = Math.min($('#cText').scrollHeight, 220) + 'px';
}
$('#cText').addEventListener('input', onCompose);
$('#cText').addEventListener('focus', typeHint);
$('#cText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#compose').requestSubmit();
});
for (const v of [50, 100, 200, 400, 700, 1000]) {
  const b = el('button', '', fmtC(v));
  b.type = 'button';
  b.dataset.v = v;
  b.addEventListener('click', () => { setBudget(v, { touched: true }); toggleBudget(false); });
  $('#cChips').append(b);
}
// The amount is edited right inside the pill; a thin row of quick amounts shows underneath.
const fitBudgetIn = () => { const i = $('#cBudgetIn'); i.style.width = Math.max(2, i.value.length + 0.4) + 'ch'; };
function toggleBudget(open = $('#cBudgetEdit').hidden) {
  $('#cBudgetEdit').hidden = !open;
  $('#cBudgetBtn').classList.toggle('editing', open);
  $('#cBudgetBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    $('#cBudgetIn').value = compose.budget || '';
    fitBudgetIn();
    requestAnimationFrame(() => { const i = $('#cBudgetIn'); i.focus(); i.select(); });
  } else $('#cBudgetIn').blur();
}
$('#cBudgetBtn').addEventListener('click', (e) => { if (!e.target.closest('input')) toggleBudget(); });
$('#cBudgetBtn').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); toggleBudget(); } });
$('#cBudgetIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); toggleBudget(false); } });
document.addEventListener('pointerdown', (e) => { if (!$('#cBudgetEdit').hidden && !e.target.closest('#cBudgetBtn, #cBudgetEdit')) toggleBudget(false); });
$('#cBudgetIn').addEventListener('input', () => {
  const raw = $('#cBudgetIn').value.replace(/[^\d.,]/g, '');
  if (raw !== $('#cBudgetIn').value) $('#cBudgetIn').value = raw; // digits only
  const v = Math.round(Number(raw.replace(/\s/g, '').replace(',', '.')));
  if (!raw) setBudget(compose.suggested, { touched: false });
  if (v > 0 && v < 100000) {
    const keep = $('#cBudgetIn').value;
    setBudget(v, { touched: true });
    $('#cBudgetIn').value = keep; // don't reformat while typing
  }
  fitBudgetIn();
});
$('#cGo').addEventListener('click', (e) => {
  if ($('#compose').classList.contains('has-text')) return; // the form submits
  e.preventDefault();
  if (state.listening) return rec?.stop();
  // Speak your mission: what you say becomes the request and starts right away.
  listen((t) => {
    $('#cText').value = t;
    compose.voice = true;
    onCompose();
    $('#compose').requestSubmit();
  }, $('#cGo'));
});
// Photos for a new mission: several, pasted or picked, shown as small thumbnails in the box.
async function addComposePhotos(files) {
  for (const f of files) {
    if (compose.photos.length >= 4) break;
    compose.photos.push(await shrink(f));
  }
  drawComposeThumbs();
  onCompose();
}
function drawComposeThumbs() {
  const box = $('#cThumbs');
  box.innerHTML = '';
  box.hidden = !compose.photos.length;
  compose.photos.forEach((src, i) => {
    const it = el('div', 'tray-item');
    it.innerHTML = `<img src="${src}" alt="${esc(t('Photo {n}', { n: i + 1 }))}"><button type="button" aria-label="${esc(t('Remove photo {n}', { n: i + 1 }))}">${svg('close')}</button>`;
    it.querySelector('img').addEventListener('click', () => openLightbox(src));
    it.querySelector('button').addEventListener('click', () => { compose.photos.splice(i, 1); drawComposeThumbs(); onCompose(); });
    box.append(it);
  });
}
$('#cPhoto').addEventListener('click', () => pickPhotos(addComposePhotos));
$('#cText').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); addComposePhotos(files); }
});
$('#compose').addEventListener('submit', async (e) => {
  e.preventDefault();
  const intent = $('#cText').value.trim();
  if (!intent && !compose.photos.length) return;
  $('#compose').classList.add('sending');
  try {
    const location = await locate();
    const emoji = compose.emoji || EMOJI.find(([re]) => re.test(intent))?.[1] || '';
    const budgetSource = compose.touched ? 'pill' : compose.auto ? 'words' : compose.budget ? 'suggested' : 'none';
    const r = await post('/api/missions', { intent, budget: compose.budget, budgetSource, emoji, location, images: compose.photos });
    state.voiceTurn = compose.voice;
    resetCompose();
    openMission(r.id);
  } catch (err) {
    if (err.code === 'mandate_required') {
      // No signed mandate (new account, or the demo server was reset): go straight to signing, keep what was written.
      try { localStorage.setItem('mandat_pending', intent); } catch {}
      try { state.me = (await get('/api/me')).user; } catch {}
      return mandateView({ why: true });
    }
    $('#cRule').textContent = err.message;
    $('#cRule').classList.add('error');
  } finally {
    $('#compose').classList.remove('sending');
    onCompose();
  }
});
function resetCompose() {
  $('#cText').value = '';
  Object.assign(compose, { emoji: null, suggested: null, photos: [], voice: false, auto: false, touched: false });
  drawComposeThumbs();
  setBudget(null);
  toggleBudget(false);
  onCompose();
}
function ruleText() {
  const lvl = state.me.rules.autonomy;
  if (!compose.budget) return t('No budget? Say one in your message, or Mandat stays under your daily limit ({limit}).', { limit: fmtC(state.me.rules.dailyCap) });
  return lvl === 'autopilot' ? t('Autopilot · books and holds deposits on its own, inside this budget.') : lvl === 'careful' ? t('Careful · asks you before every payment.') : t('Balanced · asks you before any payment over {amount}.', { amount: fmtC(state.me.rules.approveAbove) });
}
$('#newMission').addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  setTimeout(() => $('#cText').focus(), 250);
});

// Missions: three tabs — what needs you, what is moving, what is done — newest activity first.
const MTABS = {
  needs: { match: (m) => m.status === 'needs_you', empty: 'Nothing needs you right now.' },
  progress: { match: (m) => ['working', 'waiting', 'idle', 'new'].includes(m.status), empty: 'No mission in progress. Ask for something above.' },
  done: { match: (m) => m.status === 'done' || m.status === 'stopped', empty: 'Finished missions land here.' },
};
const TAB_ORDER = ['needs', 'progress', 'done'];
const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto', style: 'short' }); // same language as the interface
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return rtf.format(0, 'second');
  for (const [u, n] of [['minute', 60], ['hour', 3600], ['day', 86400], ['week', 604800]]) if (s < n * (u === 'week' ? 5 : u === 'day' ? 7 : u === 'hour' ? 24 : 60)) return rtf.format(-Math.floor(s / n), u);
  return new Date(t).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}
function renderHome(missions) {
  state.missions = missions;
  const name = (state.me.profile.name || state.me.paypal.payerName || '').split(' ')[0];
  const h = new Date().getHours();
  const today = new Date().toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  $('#hello').textContent = today.charAt(0).toUpperCase() + today.slice(1);
  $('#stoppedBanner').hidden = !state.me.frozen;
  $('#cRule').textContent = ruleText();
  $('#cRule').classList.remove('error');
  const live = missions.filter((m) => !m.archived);
  const counts = Object.fromEntries(TAB_ORDER.map((t) => [t, live.filter(MTABS[t].match).length]));
  for (const b of $$('#mTabs button')) b.querySelector('.n').textContent = counts[b.dataset.t] || '';
  // Land where it matters: what needs you first, otherwise what is moving.
  if (!state.mtab || (state.mtab === 'needs' && !counts.needs && !state.mtabChosen)) state.mtab = counts.needs ? 'needs' : counts.progress ? 'progress' : live.length ? 'done' : 'progress';
  $('#mFind').hidden = missions.length < 5;
  drawList();
  // What needs you: a dot on the Missions tab and a badge on the app icon.
  $('#tabbar button[data-tab=home]').dataset.badge = counts.needs || '';
  if ('setAppBadge' in navigator) (counts.needs ? navigator.setAppBadge(counts.needs) : navigator.clearAppBadge()).catch(() => {});
  // Offer notifications once there is something worth being told about.
  let later = false;
  try { later = localStorage.getItem('mandat.pushLater') === '1'; } catch {}
  $('#pushAsk').hidden = !(missions.length && pushSupport() === 'ok' && Notification.permission === 'default' && !state.me.notifications && !later);
}
function setTab(t, { by } = {}) {
  if (!MTABS[t] || t === state.mtab) return;
  const dir = TAB_ORDER.indexOf(t) > TAB_ORDER.indexOf(state.mtab) ? 1 : -1;
  state.mtab = t;
  state.mtabChosen = true;
  drawList(by === 'swipe' ? dir : 0);
}
function drawList(slide = 0) {
  const q = $('#mSearch').value.trim().toLowerCase();
  const all = (state.missions || []).slice().sort((a, b) => b.lastAt - a.lastAt);
  // Tab pill follows the selected tab.
  for (const b of $$('#mTabs button')) b.setAttribute('aria-selected', String(!q && b.dataset.t === state.mtab));
  placePill();
  const list = $('#mList');
  list.innerHTML = '';
  list.classList.remove('slide-l', 'slide-r');
  if (slide) { void list.offsetWidth; list.classList.add(slide > 0 ? 'slide-l' : 'slide-r'); }
  const shown = q ? all.filter((m) => (m.title + ' ' + m.last + ' ' + m.needs).toLowerCase().includes(q)) : all.filter((m) => !m.archived && MTABS[state.mtab].match(m));
  if (shown.length) list.append(rows(shown));
  else list.append(el('p', 'm-empty', q ? t('No mission matches.') : t(MTABS[state.mtab].empty)));
  // Archived missions sit, folded, at the bottom of "Done".
  const archived = all.filter((m) => m.archived);
  if (!q && state.mtab === 'done' && archived.length) {
    const tg = el('button', 'm-archived-toggle', t(state.showArchived ? 'Hide archived ({n})' : 'Show archived ({n})', { n: archived.length }));
    tg.type = 'button';
    tg.addEventListener('click', () => { state.showArchived = !state.showArchived; drawList(); });
    list.append(tg);
    if (state.showArchived) list.append(rows(archived, true));
  }
}
function placePill() {
  const sel = $(`#mTabs button[data-t=${state.mtab}]`);
  if (!sel?.offsetWidth) return;
  $('.m-tabs-pill').style.cssText = $('#mSearch').value ? 'opacity:0' : `width:${sel.offsetWidth}px;transform:translateX(${sel.offsetLeft - 4}px)`;
}
addEventListener('resize', placePill, { passive: true });
function rows(ms, faded) {
  const ol = el('ol', 'm-rows' + (faded ? ' faded' : ''));
  for (const m of ms) ol.append(missionRow(m));
  return ol;
}
for (const b of $$('#mTabs button')) b.addEventListener('click', () => setTab(b.dataset.t));
$('#mFind').addEventListener('click', () => { $('#mSearchWrap').hidden = false; $('#mTabsWrap').hidden = true; $('#mSearch').focus(); });
$('#mSearchX').addEventListener('click', () => { $('#mSearch').value = ''; $('#mSearchWrap').hidden = true; $('#mTabsWrap').hidden = false; drawList(); });
$('#mSearch').addEventListener('input', () => drawList());
// Swipe the list left or right to change tab, like a native segmented view.
(() => {
  let x0 = 0, y0 = 0, t0 = 0;
  $('#mList').addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); }, { passive: true });
  $('#mList').addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 45 || Date.now() - t0 > 700 || $('#mSearch').value) return;
    const i = TAB_ORDER.indexOf(state.mtab) + (dx < 0 ? 1 : -1);
    if (TAB_ORDER[i]) setTab(TAB_ORDER[i], { by: 'swipe' });
  }, { passive: true });
})();
const cleanTitle = (x) => String(x || t('Mission')).replace(/[\s,;:.\-–]+$/, '');
function missionLine(m) {
  if (m.status === 'needs_you') return ['needs', needText(m) || t('Waiting for you')];
  if (m.status === 'working') return ['working', t('Working on it')];
  if (m.status === 'waiting') return ['quiet', needText(m)];
  if (m.status === 'done') return ['quiet', m.held ? t('All booked · {amount} held until confirmed', { amount: fmtC(m.held, m.currency) }) : t('All booked')];
  if (m.status === 'stopped') return ['quiet', t('Paused · no payment can be made')];
  return ['quiet', m.last || t('Starting…')];
}
// What a mission waits for, in the interface language (the server also sends it in English for search).
const NEED = { approve: 'Approve {amount} at {merchant}', answer: 'Answer: {question}', accept: 'Waiting for {merchant} to accept', confirm: 'Deposit held · waiting for {merchant} to confirm' };
function needText(m) {
  const n = m.need;
  if (!n || !NEED[n.k]) return m.needs;
  return t(NEED[n.k], { ...n, amount: n.amount != null ? fmtC(n.amount, m.currency) : '' });
}
// One compact row per mission: icon · title · what is going on · when · money left.
function missionRow(m) {
  const li = el('li', 'm-row');
  li.dataset.id = m.id;
  const [cls, line] = missionLine(m);
  li.innerHTML = `<span class="m-ic">${esc(m.emoji)}</span>
    <div class="m-txt"><div class="m-l1"><b>${esc(cleanTitle(m.title))}</b><time>${ago(m.lastAt)}</time></div>
      <div class="m-l2"><span class="m-line ${cls}">${esc(line)}</span><span class="m-left">${esc(t('{amount} left', { amount: fmtC(m.remaining, m.currency) }))}</span></div></div>
    <button type="button" class="m-more" aria-label="${esc(t('More for {title}', { title: m.title }))}" aria-haspopup="menu"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>`;
  li.addEventListener('click', (e) => { if (!e.target.closest('.m-more')) openMission(m.id); });
  li.querySelector('.m-more').addEventListener('click', (e) => rowMenu(e.currentTarget, m));
  return li;
}
// "•••": archive (keeps everything) or delete (only when no money is held).
function rowMenu(btn, m) {
  const menu = $('#rowMenu');
  menu.innerHTML = '';
  const item = (label, fn, danger) => {
    const b = el('button', danger ? 'danger' : '', label);
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', async () => { closeMenu(); await fn(); });
    menu.append(b);
  };
  item(m.archived ? t('Move back to missions') : t('Archive'), async () => { await post(`/api/missions/${m.id}/archive`, { archived: !m.archived }); refreshHome(); });
  if (!m.held) item(t('Delete…'), async () => {
    if (!confirm(t('Delete “{title}”? Its conversation will be gone.', { title: m.title }))) return;
    const r = await fetch(`/api/missions/${m.id}`, { method: 'DELETE', headers: HEADERS });
    if (!r.ok) return alert((await r.json()).error);
    refreshHome();
  }, true);
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(12, innerWidth - r.right)}px`;
  menu.hidden = false;
  setTimeout(() => addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu() { $('#rowMenu').hidden = true; }
async function refreshHome() {
  const r = await get('/api/me');
  state.me = r.user;
  renderHome(r.missions);
}
const TABS = { home: () => refreshHome(), activity: () => openActivity(), settings: () => renderSettings() };
// The glass lens sits under the current tab; drag along the bar and it follows, then settles on the nearest tab.
function placeLens(x) {
  const bar = $('#tabbar'), lens = $('#tabLens');
  if (bar.hidden) return;
  const btn = $('#tabbar button[aria-current]') || $('#tabbar button');
  const left = x === undefined ? btn.offsetLeft : Math.max(4, Math.min(x - btn.offsetWidth / 2, bar.clientWidth - btn.offsetWidth - 4));
  lens.style.width = btn.offsetWidth + 'px';
  lens.style.transform = `translateX(${left}px)`;
}
addEventListener('resize', () => placeLens(), { passive: true });
(() => {
  const bar = $('#tabbar');
  let x0 = null, moved = false;
  bar.addEventListener('pointerdown', (e) => { x0 = e.clientX; moved = false; bar.classList.add('pressing'); bar.setPointerCapture(e.pointerId); });
  bar.addEventListener('pointermove', (e) => {
    if (x0 === null) return;
    if (!moved && Math.abs(e.clientX - x0) < 6) return;
    moved = true;
    bar.classList.add('dragging');
    placeLens(e.clientX - bar.getBoundingClientRect().left);
  });
  const end = (e) => {
    if (x0 === null) return;
    bar.classList.remove('dragging', 'pressing');
    const x = e.clientX - bar.getBoundingClientRect().left;
    x0 = null;
    // Settle on the tab under the finger (a plain tap is handled the same way).
    const target = [...bar.querySelectorAll('button')].find((b) => x >= b.offsetLeft && x <= b.offsetLeft + b.offsetWidth) || null;
    if (target && target.getAttribute('aria-current') == null) { TABS[target.dataset.tab](); show(target.dataset.tab); }
    else placeLens();
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
})();
$$('#tabbar button').forEach((b) => b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); TABS[b.dataset.tab](); show(b.dataset.tab); } }));
$('#resumeAll').addEventListener('click', async () => {
  state.me = (await post('/api/me/stop', { stopped: false })).user;
  refreshHome();
});
setBudget(null);
typeHint();

// ---------- a mission, live ----------
async function openMission(id) {
  if (state.es) state.es.close();
  stopWatchingShares();
  Object.assign(state, { mission: id, cards: {}, verified: {}, live: false, busy: false, streamLi: null, shareRows: {} });
  $('#newPill').hidden = true;
  $('#feed').innerHTML = '';
  const r = await get(`/api/missions/${id}`);
  $('#topTitle').textContent = cleanTitle(r.summary.title);
  setTopEmoji(r.summary.emoji);
  $('#stopMission').classList.toggle('on', r.summary.status === 'stopped');
  envelope(r.envelope);
  show('live');
  state.es = new EventSource(`/api/missions/${id}/events`);
  state.es.onmessage = (m) => handle(JSON.parse(m.data));
}
// Reserve the top bar's height in the page (it floats, fixed).
new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', $('#topbar').offsetHeight + 8 + 'px')).observe($('#topbar'));
// In a mission, the bar is one slim line; tapping the title unfolds paid / held / left.
$('#brand').addEventListener('click', () => {
  if (!state.mission || $('#live').hidden) return;
  $('#topbar').classList.toggle('expanded');
});
$('#back').addEventListener('click', () => {
  if (state.es) state.es.close();
  stopWatchingShares();
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
  const images = state.attach.slice();
  if (!t && !images.length) return;
  state.voiceTurn = false; // typed: the reply stays silent
  $('#sayText').value = '';
  state.attach = [];
  renderTray();
  syncComposer();
  send(t, images);
});
// Enter sends, Shift+Enter starts a new line; the field grows with the message.
$('#sayText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#say').requestSubmit(); }
});
// Paste images straight into the message.
$('#sayText').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); addImages(files); }
});
// Drop images anywhere on the conversation (desktop).
addEventListener('dragover', (e) => { if (!$('#live').hidden && [...(e.dataTransfer?.items || [])].some((i) => i.type.startsWith('image/'))) { e.preventDefault(); document.body.classList.add('dropping'); } });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
addEventListener('drop', (e) => {
  document.body.classList.remove('dropping');
  if ($('#live').hidden) return;
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); addImages(files); }
});
// Up to 4 images, resized on the phone before sending; shown above the bar until sent.
state.attach = [];
async function addImages(files) {
  for (const f of files) {
    if (state.attach.length >= 4) break;
    state.attach.push(await shrink(f));
  }
  renderTray();
  syncComposer();
  $('#sayText').focus();
}
function renderTray() {
  const tray = $('#tray');
  tray.innerHTML = '';
  tray.hidden = !state.attach.length || $('#live').hidden;
  state.attach.forEach((src, i) => {
    const it = el('div', 'tray-item');
    it.innerHTML = `<img src="${src}" alt="${esc(t('Photo {n} to send', { n: i + 1 }))}"><button type="button" aria-label="${esc(t('Remove photo {n}', { n: i + 1 }))}">${svg('close')}</button>`;
    it.querySelector('img').addEventListener('click', () => openLightbox(src));
    it.querySelector('button').addEventListener('click', () => { state.attach.splice(i, 1); renderTray(); syncComposer(); });
    tray.append(it);
  });
  if (state.attach.length && state.attach.length < 4) {
    const more = el('button', 'tray-add', '+');
    more.type = 'button';
    more.setAttribute('aria-label', t('Add another photo'));
    more.addEventListener('click', () => pickPhotos(addImages));
    tray.append(more);
  }
}
$('#photoBtn').addEventListener('click', () => pickPhotos(addImages));
function send(text, images = []) {
  stopSpeaking();
  state.last = { text, images };
  return post(`/api/missions/${state.mission}/messages`, { text, images }).catch((e) => add(el('li', 'step error', e.message)));
}

function handle({ type, data }) {
  switch (type) {
    case 'user': {
      // Your message: the photos first (as real thumbnails), then the words.
      const imgs = data.images || [];
      const li = el('li', 'say user' + (imgs.length ? ' with-images' : '') + (!data.text ? ' images-only' : ''));
      if (imgs.length) {
        const g = el('div', 'u-imgs n' + Math.min(imgs.length, 4));
        for (const src of imgs) {
          const im = el('img', 'zoomable');
          im.src = src;
          im.alt = t('Photo you sent');
          im.loading = 'lazy';
          g.append(im);
        }
        li.append(g);
      } else if (data.image) li.append(el('span', 'u-legacy', '📷 ' + t('Photo')));
      if (data.text) li.append(el('div', 'u-text', data.text));
      return add(li, { stick: true }); // your own message always brings you to the bottom
    }
    case 'photo_read': return addStep(data.summary, 'seen');
    // Read aloud only live replies to a spoken message, never the replayed history or replies to typing.
    case 'say': {
      const done = sayBubble(data.text);
      if (state.streamLi) { done.classList.add('settled'); state.streamLi.replaceWith(done); state.streamLi = null; keepBottom(); }
      else add(done);
      typing(state.busy);
      return state.live && state.voiceTurn && speak(plain(data.text));
    }
    case 'say_delta': return streamText(data.t);
    case 'say_reset': state.streamLi?.remove(); state.streamLi = null; return typing(state.busy);
    case 'ready':
      state.live = true;
      closeSteps();
      typing(data?.busy);
      return requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight })); // land on the latest, no animation
    case 'title': $('#topTitle').textContent = data.title; if (data.emoji) setTopEmoji(data.emoji); return;
    case 'memory': return memoryStep(data);
    case 'budget_changed': return addStep(t('Budget changed · {from} → {to}', { from: fmtC(data.from, data.currency), to: fmtC(data.to, data.currency) }));
    case 'clash': return clashCard(data);
    case 'busy': state.busy = data.on; if (!data.on) closeSteps(); typing(data.on); return orbState(data.on ? 'thinking' : state.speaking ? 'speaking' : 'idle');
    case 'tool': typing(state.busy); return toolStep(data);
    case 'places': return placesCard(data);
    case 'preview': return previewCard(data);
    case 'reminder': return reminderCard(data);
    case 'wrapup': return wrapupCard(data);
    case 'reminder_due': {
      const card = state.cards['rm:' + data.id];
      if (card) card.classList.add('done');
      return add(el('li', 'step due', data.text));
    }
    case 'verified': return verifiedMark(data);
    case 'negotiation': return negotiation(data);
    case 'request': return requestCard(data);
    case 'approval': approvalCard(data); return state.live && openSheet(data); // history replay: show the card, don't pop the sheet
    case 'approval_resolved': approvalCard({ id: data.id, status: data.approved ? 'approved' : 'declined' }); return pending?.id === data.id && closeSheet();
    case 'payment': return paymentCard(data);
    case 'envelope': return envelope(data);
    case 'plan': return planCard(data);
    case 'shares': return sharesCard(data);
    case 'share_paid': {
      const row = state.shareRows[data.invoiceId];
      if (row) shareChip(row.querySelector('.chip'), 'PAID');
      return add(step(t('{friend} paid their share: {amount}', { friend: data.friend, amount: fmt(data.amount) })));
    }
    case 'stopped': return add(step(data.stopped ? t('Stopped. No payment will be made until you resume.') : t('Resumed.')));
    case 'error': return add(errorStep(data.message));
  }
}

const TOOL_LABEL = {
  show_place_preview: (a) => t('Looking up {name}', { name: a.name }),
  check_schedule: () => t('Checking your schedule'),
  find_real_places: (a) => t('Looking for real {places} nearby', { places: many(a.category) }),
  find_network_merchants: (a) => t('Checking {places} I can book and pay', { places: many(a.category) }),
  cancel_hold: () => t('Releasing a hold'),
  split_bill: () => t('Preparing PayPal links for your friends'),
};
function toolStep({ name, args }) {
  const label = TOOL_LABEL[name]?.(args);
  if (label) addStep(label);
}
// The agent's small steps collapse into one quiet line ("Worked through 6 steps ›"); the latest shows while it works.
function addStep(text, cls = 'step') {
  const feed = $('#feed');
  let g = [...feed.children].filter((c) => !c.classList.contains('typing')).pop();
  if (!g || !g.classList.contains('steps') || g.classList.contains('closed-group')) {
    g = el('li', 'steps');
    g.innerHTML = '<button type="button" class="steps-head"><span class="steps-dot"></span><span class="steps-label"></span><span class="chev" aria-hidden="true"></span></button><div class="fold-body"><ol class="steps-list fold-inner"></ol></div>';
    g.querySelector('.steps-head').addEventListener('click', () => g.classList.contains('multi') && g.classList.toggle('open'));
    add(g);
  }
  g.querySelector('.steps-list').append(el('li', cls, text));
  const n = g.querySelectorAll('.steps-list li').length;
  g.classList.toggle('multi', n > 1);
  g.querySelector('.steps-label').textContent = text;
  if (!state.busy) closeSteps();
}
function closeSteps() {
  for (const g of $$('#feed > li.steps:not(.closed-group)')) {
    const n = g.querySelectorAll('.steps-list li').length;
    if (n > 1) g.querySelector('.steps-label').textContent = tn(n, 'Worked through {n} step', 'Worked through {n} steps');
    g.classList.add('closed-group');
  }
}
// Cards fold to one line; tap the header to unfold (the open state survives updates).
function fold(card, openByDefault = false) {
  const head = card.querySelector(':scope > header');
  if (!head) return card;
  if (!card.querySelector(':scope > .fold-body')) {
    const body = el('div', 'fold-body');
    const inner = el('div', 'fold-inner');
    for (const c of [...card.children]) if (c !== head) inner.append(c);
    body.append(inner);
    card.append(body);
  }
  if (!head.querySelector('.chev')) head.append(el('span', 'chev'));
  if (card.dataset.open === undefined) card.dataset.open = openByDefault ? '1' : '0';
  card.classList.add('fold');
  card.classList.toggle('open', card.dataset.open === '1');
  head.onclick = (e) => {
    if (e.target.closest('button, a')) return;
    card.dataset.open = card.dataset.open === '1' ? '0' : '1';
    card.classList.toggle('open', card.dataset.open === '1');
  };
  return card;
}
// Real places, on an interactive map right in the conversation (MapLibre + OpenFreeMap: free, no key).
const MAPLIBRE = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5/dist/';
let maplibreReady;
function loadMapLibre() {
  return (maplibreReady ||= new Promise((ok, ko) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = MAPLIBRE + 'maplibre-gl.css';
    document.head.append(css);
    const js = document.createElement('script');
    js.src = MAPLIBRE + 'maplibre-gl.js';
    js.onload = () => ok(window.maplibregl);
    js.onerror = () => { maplibreReady = null; ko(new Error('map unavailable')); };
    document.head.append(js);
  }));
}
// A map starts only when its card scrolls into view (a long history never opens dozens of maps).
const mapWatcher = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { mapWatcher.unobserve(e.target); e.target.start(); }
}, { rootMargin: '200px' });

function placesCard({ category, center, places }) {
  if (!places?.length) return;
  const shown = places.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)).slice(0, 5);
  const li = el('li', 'card places');
  li.innerHTML = `<header><span class="avatar" style="background:#19a463">⌖</span><div><b>${esc(t('{n} real {places} nearby', { n: places.length, places: many(category) }))}</b><small>${esc(places.slice(0, 2).map((p) => p.name).join(', '))}${places.length > 2 ? '…' : ''} · ${t('map')}</small></div></header>
    ${shown.length ? `<div class="place-map" role="region" aria-label="${esc(t('Map of {places} nearby', { places: many(category) }))}"></div>` : ''}
    <ol class="place-list">${(shown.length ? shown : places.slice(0, 4)).map((p, i) => `<li><button type="button" data-i="${i}"><span class="pin-n">${i + 1}</span><span class="pl-name">${esc(p.name)}</span><span class="pl-meta">${p.distance} m${p.openingHours ? ' · ' + esc(p.openingHours.slice(0, 28)) : ''}</span></button></li>`).join('')}</ol>`;
  add(fold(li));
  const box = li.querySelector('.place-map');
  if (!box) return;
  box.start = async () => {
    let ml;
    try { ml = await loadMapLibre(); } catch { return box.remove(); }
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const map = new ml.Map({
      container: box,
      style: `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`,
      center: center ? [center.lon, center.lat] : [shown[0].lon, shown[0].lat],
      zoom: 15,
      cooperativeGestures: true,
      attributionControl: { compact: true },
    });
    map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
    const bounds = new ml.LngLatBounds();
    if (center) {
      new ml.Marker({ element: el('div', 'me-dot') }).setLngLat([center.lon, center.lat]).addTo(map);
      bounds.extend([center.lon, center.lat]);
    }
    const pins = shown.map((p, i) => {
      const pin = el('button', 'pin'); // MapLibre owns this element's transform; the drop shape lives inside
      pin.innerHTML = `<span class="pin-body"><b>${i + 1}</b></span>`;
      pin.type = 'button';
      pin.setAttribute('aria-label', p.name);
      pin.addEventListener('click', (e) => { e.stopPropagation(); select(i); });
      new ml.Marker({ element: pin, anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(map);
      bounds.extend([p.lon, p.lat]);
      return pin;
    });
    map.fitBounds(bounds, { padding: { top: 46, bottom: 30, left: 30, right: 30 }, maxZoom: 16, duration: 0 });
    // Keep the (required) OpenStreetMap credit folded into its small "i" until asked for.
    map.once('load', () => {
      box.querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show');
      box.classList.add('ready'); // fade in once tiles are drawn
    });
    const popup = new ml.Popup({ offset: [0, -34], anchor: 'bottom', closeButton: false, focusAfterOpen: false, className: 'place-pop' });
    const select = (i) => {
      const p = shown[i];
      li.querySelectorAll('.place-list button').forEach((b, j) => b.classList.toggle('on', j === i));
      pins.forEach((pin, j) => pin.classList.toggle('on', j === i));
      map.flyTo({ center: [p.lon, p.lat], offset: [0, 55], zoom: Math.max(map.getZoom(), 16), duration: 700 }); // pin sits low, bubble fits above
      popup.setLngLat([p.lon, p.lat])
        .setHTML(`<b>${esc(p.name)}</b><span>${esc(t('{n} m away', { n: p.distance }))}</span><a href="https://maps.apple.com/?daddr=${p.lat},${p.lon}" target="_blank" rel="noopener">${t('Directions')}</a>`)
        .addTo(map);
    };
    li.querySelectorAll('.place-list button').forEach((b) => b.addEventListener('click', () => select(+b.dataset.i)));
  };
  mapWatcher.observe(box);
}
// A real place, at a glance: photos (open sources), details, and one tap to Google Maps for everyone's photos.
function previewCard(v) {
  const li = el('li', 'card preview');
  const photos = v.photos || [];
  const meta = [v.rating ? `★ ${v.rating.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${v.ratings ? ` (${v.ratings.toLocaleString(locale())})` : ''}` : '', v.cuisine || v.category, v.distance != null ? `${v.distance} m` : '', v.openingHours ? v.openingHours.slice(0, 40) : ''].filter(Boolean).map(esc).join(' · ');
  li.innerHTML = `${photos.length
    ? `<div class="pv-photos">${photos.map((p) => `<img class="zoomable" src="${esc(p.url)}" alt="${esc(v.name)}" loading="lazy" referrerpolicy="no-referrer">`).join('')}</div>`
    : noPhoto(v)}
    <div class="pv-body"><b>${esc(v.name)}</b><small>${meta}</small>${v.address ? `<small>${esc(v.address)}</small>` : ''}
      <div class="pv-actions"><a class="pill-btn" href="${esc(v.googleMaps)}" target="_blank" rel="noopener">${t('Photos on Google Maps')}</a>${v.directions ? `<a href="${esc(v.directions)}" target="_blank" rel="noopener">${t('Directions')}</a>` : ''}${v.website ? `<a href="${esc(/^https?:/.test(v.website) ? v.website : 'https://' + v.website)}" target="_blank" rel="noopener">${t('Website')}</a>` : ''}</div>
      ${photos.length ? `<p class="pv-src">${esc(t('Photos: {sources}', { sources: [...new Set(photos.map((p) => p.source))].join(', ') }))}</p>` : ''}</div>`;
  // A photo that cannot load disappears instead of leaving a broken frame.
  // A photo that cannot load (or a Google link that expired) gives way to the Google Maps button.
  li.querySelectorAll('.pv-photos img').forEach((im) => im.addEventListener('error', () => {
    im.remove();
    const strip = li.querySelector('.pv-photos');
    if (strip && !strip.querySelector('img')) strip.outerHTML = noPhoto(v);
  }));
  add(li);
}
// "All set": the whole result at a glance, the money, the reminders — and an easy way to change anything.
function wrapupCard(w) {
  state.cards.wrap?.remove();
  const li = state.cards.wrap = el('li', 'card wrapup');
  const day = (x) => {
    if (!x) return '';
    const d = new Date(String(x).slice(0, 10) + 'T12:00:00');
    const hm = /\d{2}:\d{2}/.test(x) ? String(x).match(/\d{2}:\d{2}/)[0] : '';
    return `${d.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' })}${hm ? ' · ' + hm : ''}`;
  };
  const money = [w.paid ? t('{amount} paid', { amount: fmtC(w.paid, w.currency) }) : '', w.held ? t('{amount} held until confirmed', { amount: fmtC(w.held, w.currency) }) : ''].filter(Boolean).join(' · ');
  li.innerHTML = `<div class="wu-head"><span class="wu-check">${svg('check')}</span><div><b>${esc(t(w.headline))}</b><small>${esc(money || t('Nothing left to do'))}</small></div></div>
    <ol class="wu-lines">${(w.lines || []).map((l) => `<li><span class="wu-when">${esc(day(l.when))}</span><span class="wu-what">${esc(l.what)}${l.where ? ` <i>· ${esc(l.where)}</i>` : ''}</span></li>`).join('')}</ol>
    ${w.note ? `<p class="wu-note">${esc(w.note)}</p>` : ''}
    ${w.reminders?.length ? `<p class="wu-rem">⏰ ${esc(t('{times} · on your phone', { times: w.reminders.map((r) => new Date(r.at).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' })).join(' · ') }))}</p>` : ''}
    <div class="wu-actions"><a class="pill-btn" href="/api/missions/${state.mission}/calendar.ics">${svg('cal')} ${t('Add all to Calendar')}</a><button type="button" class="wu-change">${t('Change something')}</button></div>`;
  li.querySelector('.wu-change').addEventListener('click', () => { const box = $('#sayText'); box.value = t('I would like to change '); syncComposer(); box.focus(); });
  add(li);
}
// The mission's emoji replaces the brand mark in the top bar.
function setTopEmoji(e) {
  $('#topEmoji').textContent = e || '';
  $('#topEmoji').hidden = !e;
  $('#brand').classList.toggle('has-emoji', !!e);
}
// Memory: a quiet line in the steps ("Noted for next time · Ana is vegetarian").
function memoryStep(m) {
  if (m.action === 'forgotten') return addStep(t('Updated my memory'), 'step mem');
  addStep(`${m.scope === 'mission' ? t('Noted for this mission') : t('Noted for next time')} · ${m.text}`, 'step mem');
  if (m.scope === 'global' && state.me) state.me.memory = [...(state.me.memory || []).filter((x) => x.id !== m.id), m];
}
// A clash with something already planned (here or in another mission), with a way to look at it.
const CLASH_TITLE = { overlap: 'Schedule clash', too_close: 'Tight timing', double_stay: 'Two stays on the same night', away: 'You may be away' };
function clashCard(c) {
  const li = el('li', 'card clash');
  li.innerHTML = `<span class="cl-ic" aria-hidden="true">!</span><div class="cl-main"><b>${esc(t(CLASH_TITLE[c.type] || 'Clash'))}</b><small>${esc(c.shown || c.text)}</small></div>${c.with?.missionId ? `<button type="button" class="cl-open">${t('Open')}</button>` : ''}`;
  li.querySelector('.cl-open')?.addEventListener('click', () => openMission(c.with.missionId));
  add(li);
}
// A scheduled reminder: when it will ping the phone, and one tap to put it in the calendar.
function reminderCard(r) {
  if (state.cards['rm:' + r.id]) return;
  const li = el('li', 'card reminder' + (r.sent ? ' done' : ''));
  const when = new Date(r.at);
  const label = when.toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  li.innerHTML = `<span class="rm-ic">${svg('bell')}</span><div class="rm-main"><b>${esc(r.text)}</b><small>${esc(t('Notification · {when}', { when: label }))}</small></div><a class="rm-cal" href="/api/missions/${state.mission}/reminders/${r.id}.ics" aria-label="${esc(t('Add to Calendar'))}">${svg('cal')}</a>`;
  state.cards['rm:' + r.id] = li;
  add(li);
}
function noPhoto(v) {
  return `<a class="pv-none" href="${esc(v.googleMaps)}" target="_blank" rel="noopener"><span>📍</span><b>${t('See photos on Google Maps')}</b><small>${esc(t('People’s photos and reviews of {name}', { name: v.name }))}</small></a>`;
}
function verifiedMark({ merchant_id, name, ok }) {
  state.verified[merchant_id] = ok;
  const card = state.cards['n:' + merchant_id];
  if (card) card.querySelector('.shield').hidden = !ok;
  addStep(t(ok ? '{name}: identity verified' : '{name}: identity could not be verified', { name }));
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
  const n = card.querySelectorAll('.bubbles li').length;
  card.querySelector('.sub').textContent = offer?.total ? `${t('Offer {amount}', { amount: fmt(offer.total) })}${offer.discount ? ` · −${fmt(offer.discount)}` : ''} · ${tn(n, '{n} message', '{n} messages')}` : `${t('Negotiating with their AI agent')} · ${tn(n, '{n} message', '{n} messages')}`;
  fold(card);
  if (offer) {
    const o = card.querySelector('.offer');
    o.hidden = false;
    o.innerHTML = [offer.slot && `<span>${esc(offer.slot)}</span>`, offer.discount ? `<span>−${fmt(offer.discount)}</span>` : '', offer.deposit ? `<span>${esc(t('deposit {amount}', { amount: fmt(offer.deposit) }))}</span>` : '', offer.total ? `<span class="total">${fmt(offer.total)}</span>` : ''].filter(Boolean).join('');
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
  const [label, cls] = { accepted: ['Accepted', 'wait'], confirmed: ['Confirmed', 'paid'], declined: ['Declined', 'off'], countered: ['Other time', 'part'] }[r.status] || ['Waiting', 'wait'];
  const sub = r.status === 'pending' ? t('No AI agent · request sent to their inbox') : r.status === 'countered' ? t('Proposes {slot} instead', { slot: r.counterSlot }) : r.status === 'accepted' ? t('Accepted · confirms when the deposit is held') : r.status === 'confirmed' ? t('Confirmed · deposit paid with PayPal') : t('Declined');
  card.innerHTML = `<header><span class="avatar m">${esc(r.merchant[0])}</span><div><b>${esc(r.merchant)}</b><small>${esc(sub)}</small></div><span class="chip ${cls}">${t(label)}</span></header>
    <p>${r.items.map((i) => `${i.qty}× ${esc(i.label)}`).join(', ')}${r.slot ? ' · ' + esc(r.slot) : ''} · ${esc(t('{total}, deposit {deposit}', { total: fmt(r.total), deposit: fmt(r.deposit) }))}</p>${r.reply ? `<p class="req-reply">${esc(t('“{text}”', { text: r.reply }))}</p>` : ''}
    ${r.inbox && (r.status === 'pending' || r.status === 'accepted') ? `<a class="inbox-link" href="${esc(r.inbox)}" target="_blank" rel="noopener">${esc(t('See it from {merchant}’s side (demo inbox)', { merchant: r.merchant }))} ↗</a>` : ''}`;
  fold(card);
}
// Money moments: held (reserved, not charged), paid (merchant confirmed), refunded.
// "Tren Azul — 6 rail legs" shown under "Tren Azul" reads as "6 rail legs".
const shortLabel = (merchant, label) => String(label || '').replace(new RegExp('^' + String(merchant).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[—–:-]\\s*'), '');
// One card per payment, updated in place: held → paid (→ refunded).
function paymentCard({ kind, entry, mode, why, reason }) {
  let li = state.cards['p:' + entry.id];
  const isNew = !li;
  if (isNew) li = state.cards['p:' + entry.id] = el('li', 'card pay');
  li.className = 'card pay ' + kind + (kind === 'capture' ? ' captured' : '');
  const [icon, title, sub] = kind === 'hold' ? ['lock', t('Held with PayPal'), t('Not charged until the merchant confirms')]
    : kind === 'capture' ? ['check', t('Paid with PayPal'), why ? t(why) + ' · ' + t('deposit captured') : t('Merchant confirmed · deposit captured')]
    : ['undo', t('Refunded with PayPal'), reason || t('Back to your PayPal')];
  li.innerHTML = `<header><span class="lock">${svg(icon)}</span><div class="pay-main"><b>${esc(entry.merchant)}</b><small>${title}</small></div><span class="amt">${kind === 'refund' ? '+' : ''}${fmt(entry.amount)}</span></header>
    <div class="pay-detail"><p>${esc(shortLabel(entry.merchant, entry.label))}</p><p class="why">${esc(sub)} · ${mode === 'sandbox' ? t('PayPal sandbox') : mode ? t('PayPal (demo)') : 'PayPal'}</p></div>`;
  fold(li);
  if (isNew) add(li);
}
// The plan as a day-by-day timeline, with the running total against the mission budget.
const KIND = { transport: '🚆', stay: '🛏️', activity: '🎟️', food: '🍽️', other: '•' };
const PLAN_STATUS = { idea: ['Idea', 'off'], searching: ['Searching', 'off'], negotiating: ['Negotiating', 'part'], requested: ['Requested', 'part'], awaiting_approval: ['Needs you', 'wait'], held: ['Held', 'wait'], confirmed: ['Booked', 'paid'], cancelled: ['Cancelled', 'off'] };
function planCard({ items }) {
  let card = state.cards.plan;
  if (!card) card = state.cards.plan = el('li', 'card plan');
  const day = (w) => (/^\d{4}-\d{2}-\d{2}/.test(w || '') ? w.slice(0, 10) : '');
  const sorted = items.map((it, i) => ({ ...it, i, d: day(it.when) })).sort((x, y) => (x.d && y.d ? x.d.localeCompare(y.d) || (x.when || '').localeCompare(y.when || '') : x.d ? -1 : y.d ? 1 : x.i - y.i));
  const first = sorted.find((x) => x.d)?.d;
  const groups = [];
  for (const it of sorted) {
    const key = it.d || 'later';
    if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, items: [] });
    groups[groups.length - 1].items.push(it);
  }
  const label = (d) => {
    if (d === 'later') return t('To schedule');
    const dt = new Date(d + 'T12:00:00');
    const n = first ? Math.round((dt - new Date(first + 'T12:00:00')) / 864e5) + 1 : 0;
    return `${dt.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' })}${n > 0 && groups.length > 1 ? ' · ' + t('Day {n}', { n }) : ''}`;
  };
  const planned = items.filter((i) => i.status !== 'cancelled' && i.total > 0).reduce((t, i) => t + i.total, 0);
  const budget = state.envTotal || 0;
  const multiDay = groups.filter((g) => g.key !== 'later').length > 1;
  const booked = items.filter((i) => i.status === 'confirmed' || i.status === 'held').length;
  card.innerHTML = `<header><span class="avatar plan-ic">${svg('route')}</span><div><b>${multiDay ? t('Your trip, day by day') : t('Your plan')}</b><small>${t('{done}/{total} booked', { done: booked, total: items.length })}${planned ? ` · ${budget ? t('{amount} of {total}', { amount: fmt(planned), total: fmt(budget) }) : fmt(planned)}` : ''}</small></div></header>
    <div class="timeline">${groups.map((g) => `<section class="tl-day"><h3>${label(g.key)}</h3>${g.items.map((it) => {
      const [st, cls] = PLAN_STATUS[it.status] || [it.status, 'off'];
      const time = /\d{2}:\d{2}/.test(it.when || '') ? it.when.match(/\d{2}:\d{2}/)[0] : !it.d && it.when ? it.when : '';
      return `<div class="tl-item ${it.status === 'cancelled' ? 'off' : ''}"><span class="tl-ic">${KIND[it.kind] || (/(train|flight|bus|→)/i.test(it.what) ? '🚆' : /(night|hostel|hotel|room|stay)/i.test(it.what) ? '🛏️' : '•')}</span>
        <div class="tl-main"><b>${esc(it.what)}${it.nights ? ` · ${tn(it.nights, '{n} night', '{n} nights')}` : ''}</b><small>${[it.merchant, time].filter(Boolean).map(esc).join(' · ')}</small></div>
        <div class="tl-side">${it.total ? `<span class="tl-amt">${fmt(it.total)}</span>` : ''}<span class="chip ${cls}">${t(st)}</span></div></div>`;
    }).join('')}</section>`).join('')}</div>
    ${items.some((i) => /^\d{4}-\d{2}-\d{2}/.test(i.when || '') && i.status !== 'cancelled') ? `<a class="tl-cal" href="/api/missions/${state.mission}/calendar.ics">${svg('cal')} ${multiDay ? t('Add the whole trip') : t('Add to Calendar')}</a>` : ''}
    ${planned ? `<div class="tl-total"><span>${budget ? t('Planned {amount} of {total}', { amount: fmt(planned), total: fmt(budget) }) : t('Planned {amount}', { amount: fmt(planned) })}</span>${budget ? `<span class="${planned > budget ? 'over' : ''}">${esc(planned > budget ? t('Over by {amount}', { amount: fmt(planned - budget) }) : t('{amount} left for food & extras', { amount: fmt(budget - planned) }))}</span>` : ''}</div>
    <div class="tl-bar"><i style="width:${budget ? Math.min(100, (100 * planned) / budget) : 0}%"></i></div>` : ''}`;
  fold(card);
  if (!card.isConnected) add(card);
}
// Split bill: one real PayPal invoice per friend — emailed by PayPal, plus a pay link and a QR code.
const SHARE_STATUS = { PAID: ['Paid', 'paid'], PARTIALLY_PAID: ['Part paid', 'part'], CANCELLED: ['Cancelled', 'off'], REFUNDED: ['Refunded', 'off'] };
function shareChip(chip, status, mode) {
  const [text, cls] = mode === 'offline' ? ['Demo', 'off'] : SHARE_STATUS[status] || ['Waiting', 'wait'];
  chip.textContent = t(text);
  chip.className = 'chip ' + cls;
}
function splitDetails(b) {
  if (!b) return '';
  const when = b.date ? new Date(b.date + 'T12:00:00').toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) : '';
  const payer = b.people.find((p) => p.payer);
  const paid = esc(t(b.where ? '{name} paid {amount} at {place}' : '{name} paid {amount}', { name: payer?.name || t('You'), place: b.where })).replace('{amount}', `<b>${fmt(b.total)}</b>`);
  return `<details class="split-how"><summary>${t('How it was split')}</summary>
    <p class="split-paid">${paid}${when ? ` · ${when}` : ''}</p>
    ${b.items?.length ? `<ul class="split-lines">${b.items.map((i) => `<li><span>${esc(i.name)}</span><span>${fmt(i.total)}</span></li>`).join('')}</ul>` : ''}
    <ul class="split-lines people">${b.people.map((p) => `<li><span>${esc(p.name)}${p.payer ? ` <em>${t('paid the bill')}</em>` : ''}</span><span>${fmt(p.amount)}</span></li>`).join('')}</ul>
    <p class="split-note">${esc(b.equal ? t('Split equally between {n} people.', { n: b.people.length }) : t('Unequal split, as you asked.'))}${b.rounding ? ' ' + esc(t('{name} covers the extra {amount} from rounding.', { name: b.rounding.name, amount: fmt(b.rounding.amount) })) : ''} ${t('Each invoice lists these lines and the person’s own part.')}</p>
  </details>`;
}
function sharesCard({ label, per, links, breakdown }) {
  const li = el('li', 'card split');
  li.innerHTML = `<header><span class="avatar" style="background:#7b61ff">👥</span><div><b>${esc(t('Split · {label}', { label }))}</b><small class="split-sum">${breakdown ? fmt(breakdown.total) + ' · ' : ''}${tn(links.length, '{n} invoice sent', '{n} invoices sent')}</small></div></header>
    ${splitDetails(breakdown)}<ul class="split-list"></ul>
    <p class="split-foot">${t('No app needed to pay: from PayPal’s email, the link, or the QR code.')}</p>`;
  const ul = li.querySelector('.split-list');
  for (const l of links) {
    const row = el('li', 'split-row');
    if (l.error) {
      row.innerHTML = `<div class="split-top"><span class="who"><b>${esc(l.friend)}</b><small>${t('Could not create the invoice')}</small></span><span class="amt">${fmt(l.amount)}</span></div>`;
      ul.append(row);
      continue;
    }
    row.innerHTML = `<span class="who"><b>${esc(l.friend)}</b><small>${l.emailed ? t('Emailed') : t('Link & QR')}</small></span><span class="amt">${fmt(l.amount)}</span><span class="chip"></span>
      <span class="split-actions"><button type="button" data-a="qr" aria-label="${esc(t('Show {name}’s QR code', { name: l.friend }))}">${svg('qr')}</button><button type="button" data-a="share" aria-label="${esc(t('Send {name} the link', { name: l.friend }))}">${svg('share')}</button><button type="button" data-a="copy" aria-label="${esc(t('Copy {name}’s pay link', { name: l.friend }))}">${svg('copy')}</button></span>`;
    shareChip(row.querySelector('.chip'), l.status, l.mode);
    state.shareRows[l.invoiceId] = row;
    const text = t('{name}, your share for {label}: {amount}. Pay with PayPal:', { name: l.friend, label, amount: fmt(l.amount) });
    row.querySelector('[data-a=qr]').addEventListener('click', () => (l.qr ? openLightbox(l.qr) : alert(t('No QR code in demo mode.'))));
    row.querySelector('[data-a=share]').addEventListener('click', async (e) => {
      if (navigator.share) return navigator.share({ title: t('Your share'), text, url: l.payUrl }).catch(() => {});
      await navigator.clipboard.writeText(`${text} ${l.payUrl}`).catch(() => {});
      flashIcon(e.currentTarget, 'share');
    });
    row.querySelector('[data-a=copy]').addEventListener('click', async (e) => {
      await navigator.clipboard.writeText(l.payUrl).catch(() => {});
      flashIcon(e.currentTarget, 'copy');
    });
    ul.append(row);
  }
  add(fold(li));
  updateSplitSummary(li);
  watchShares();
}
function updateSplitSummary(card) {
  const chips = [...card.querySelectorAll('.split-row .chip')];
  const paid = chips.filter((c) => c.classList.contains('paid')).length;
  const s = card.querySelector('.split-sum');
  if (!s || !chips.length) return;
  s.dataset.base ??= s.textContent;
  s.textContent = s.dataset.base + ' · ' + t('{paid}/{total} paid', { paid, total: chips.length });
}
function flashIcon(b, name) {
  b.innerHTML = svg('check');
  setTimeout(() => (b.innerHTML = svg(name)), 1400);
}
function flashLabel(b, text) {
  const html = b.innerHTML;
  b.innerHTML = svg('check') + text;
  setTimeout(() => (b.innerHTML = html), 1400);
}
// While a mission is open and someone still owes their share, ask PayPal for news every 15 s.
function watchShares() {
  if (state.shareTimer || !state.mission) return;
  const tick = async () => {
    try {
      const { shares } = await get(`/api/missions/${state.mission}/shares`);
      for (const sh of shares) {
        const row = state.shareRows[sh.invoiceId];
        if (row) { shareChip(row.querySelector('.chip'), sh.status, sh.mode); updateSplitSummary(row.closest('.card')); }
      }
      if (!shares.some((sh) => !sh.error && sh.mode !== 'offline' && !['PAID', 'CANCELLED', 'REFUNDED'].includes(sh.status))) stopWatchingShares();
    } catch {}
  };
  state.shareTimer = setInterval(tick, 15000);
  setTimeout(tick, 1500);
}
function stopWatchingShares() {
  clearInterval(state.shareTimer);
  state.shareTimer = null;
}
function envelope(e) {
  state.currency = e.currency;
  state.envTotal = e.total;
  $('#envSpent').textContent = fmt(e.spent);
  $('#envHeld').textContent = fmt(e.held);
  $('#envLeft').textContent = fmt(e.remaining);
  $('#topSub').textContent = `${t('{amount} left of {total}', { amount: fmt(e.remaining), total: fmt(e.total) })}${e.held ? ' · ' + t('{amount} held', { amount: fmt(e.held) }) : ''}${e.spent ? ' · ' + t('{amount} paid', { amount: fmt(e.spent) }) : ''}`;
  const p = (v) => (100 * v) / (e.total || 1);
  $('.env-bar .spent').style.width = p(e.spent) + '%';
  $('.env-bar .held').style.width = p(e.held) + '%';
  // Receipts: every payment of this mission with its PayPal reference (shown when the bar is unfolded).
  const RS = { held: ['Held', 'wait'], captured: ['Paid', 'paid'], released: ['Released', 'off'], refunded: ['Refunded', 'part'] };
  $('#receipts').innerHTML = (e.entries || []).length
    ? e.entries.map((x) => {
      const [st, cls] = RS[x.state] || [x.state, 'off'];
      const ref = x.paypal?.captureId || x.paypal?.authorizationId || '';
      return `<li><div><b>${esc(x.merchant)}</b><small>${esc(shortLabel(x.merchant, x.label))}${ref ? ` · <span class="ref">${esc(ref)}</span>` : ''}</small></div><span class="chip ${cls}">${t(st)}</span><span class="r-amt">${fmt(x.amount - (x.refunded || 0))}</span></li>`;
    }).join('')
    : `<li class="none">${t('No payment yet in this mission.')}</li>`;
}

// ---------- approval sheet: hold to approve ----------
let pending = null;
function openSheet(a) {
  if (a.status && a.status !== 'pending') return;
  pending = a;
  $('#sheetMerchant').textContent = t('Pay {merchant} (via Mandat)', { merchant: a.merchant });
  $('#sheetLines').innerHTML = `<div><span>${esc(a.label)}</span><span>${fmt(a.amount)}</span></div>${a.offer_total ? `<div><span>${t('Booking total')}</span><span>${fmt(a.offer_total)}</span></div>` : ''}`;
  $('#sheetAmount').textContent = fmt(a.amount);
  $('#sheetFine').textContent = (a.reason ? a.reason + '. ' : '') + t('Held with PayPal, not charged until the merchant confirms. Cancel anytime and it returns to your mission budget.');
  const btn = $('#sheetApprove');
  btn.className = 'hold-btn';
  btn.querySelector('.label').textContent = t('Hold to approve');
  $('#scrim').hidden = false;
  $('#sheet').hidden = false;
}
function closeSheet() {
  $('#scrim').hidden = true;
  $('#sheet').hidden = true;
  pending = null;
}
// A payment waiting for you stays in the conversation until you decide; tap to review.
function approvalCard(a) {
  let card = state.cards['a:' + a.id];
  if (!card) {
    if (!a.merchant) return;
    card = state.cards['a:' + a.id] = el('li', 'card approve');
    card.data = a;
    add(card);
  }
  const d = { ...card.data, ...a };
  card.data = d;
  const open = d.status === 'pending' || !d.status;
  card.className = 'card approve ' + (open ? 'open' : d.status);
  card.innerHTML = `<span class="pp-mini">PayPal</span><div class="ap-main"><b>${esc(t(open ? 'Approve {amount}' : d.status === 'approved' ? 'Approved {amount}' : 'Declined {amount}', { amount: fmt(d.amount) }))}</b><small>${esc(d.merchant)} · ${esc(shortLabel(d.merchant, d.label))}</small></div>${open ? `<button type="button" class="pill-btn">${t('Review')}</button>` : `<span class="chip ${d.status === 'approved' ? 'paid' : 'off'}">${d.status === 'approved' ? t('Approved') : t('Declined')}</span>`}`;
  if (open) card.querySelector('button').addEventListener('click', () => openSheet(d));
}
$('#scrim').addEventListener('click', closeSheet);
$('#sheetLater').addEventListener('click', closeSheet);
(() => {
  const btn = $('#sheetApprove');
  let timer = null;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!pending) return;
    btn.classList.add('holding');
    timer = setTimeout(async () => {
      btn.classList.add('done');
      btn.querySelector('.label').textContent = t('Approved');
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
// ---------- activity: AG Grid ledger ----------
const AG = 'https://cdn.jsdelivr.net/npm/ag-grid-community@36.2.0/dist/ag-grid-community.min.js';
let agReady, ledger;
function loadAgGrid() {
  return (agReady ||= new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = AG;
    s.onload = () => ok(window.agGrid);
    s.onerror = () => { agReady = null; ko(new Error('grid unavailable')); };
    document.head.append(s);
  }));
}
// The grid wears the app's materials, in light and dark.
function ledgerTheme(ag) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return ag.themeQuartz.withParams({
    fontFamily: '-apple-system, "SF Pro Text", system-ui, sans-serif',
    fontSize: 14,
    headerFontSize: 12,
    headerFontWeight: 600,
    accentColor: '#0a84ff',
    backgroundColor: dark ? '#1c1d22' : '#ffffff',
    foregroundColor: dark ? '#f2f2f7' : '#1c1c1e',
    headerBackgroundColor: dark ? '#22232a' : '#f7f6f3',
    headerTextColor: dark ? '#9a9aa2' : '#6e6e73',
    borderColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)',
    rowHoverColor: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
    wrapperBorderRadius: 16,
    spacing: 6,
    rowVerticalPaddingScale: 0.9,
  });
}
const STATUS_CLS = { Held: 'wait', Paid: 'paid', 'Paid back': 'paid', Released: 'off', Refunded: 'part', 'Owed to you': 'wait', Failed: 'off' };
// Statuses and kinds stay in English in the data (the plain-words filter uses them); only their display is translated.
const kindLabel = (k) => t(k === 'Share' ? 'Bill share' : k || '');
const dayMonth = (d) => d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
function ledgerColumns(narrow) {
  return [
    { field: 'at', headerName: t('When'), filter: 'agDateColumnFilter', sort: 'desc', width: 112, minWidth: 96, hide: narrow,
      valueGetter: (p) => (p.data?.at ? new Date(p.data.at) : null),
      valueFormatter: (p) => (p.value ? dayMonth(p.value) + ' · ' + p.value.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : ''),
      filterParams: { comparator: (d, v) => { const x = new Date(v); x.setHours(0, 0, 0, 0); return x < d ? -1 : x > d ? 1 : 0; } } },
    { field: 'who', headerName: narrow ? t('Who') : t('Merchant / friend'), filter: 'agTextColumnFilter', flex: 1.2, minWidth: 110,
      // On a phone the date sits under the name, so three columns are enough: who, status, amount.
      cellRenderer: (p) => (p.data ? `<span class="led-who"><span class="led-emoji">${p.data.kind === 'Share' ? '👥' : esc(p.data.emoji)}</span><span class="led-name">${esc(p.value)}${innerWidth < 720 && p.data.at ? `<small>${dayMonth(new Date(p.data.at))}</small>` : ''}</span></span>` : esc(p.value)) },
    { field: 'mission', headerName: t('Mission'), filter: 'agTextColumnFilter', flex: 1.2, minWidth: 110, hide: narrow },
    { field: 'what', headerName: t('What'), filter: 'agTextColumnFilter', flex: 1.4, minWidth: 110, hide: narrow },
    { field: 'kind', headerName: t('Type'), filter: 'agTextColumnFilter', width: 100, hide: narrow, valueFormatter: (p) => kindLabel(p.value) },
    { field: 'status', headerName: t('Status'), filter: 'agTextColumnFilter', width: narrow ? 84 : 128, minWidth: 76,
      cellRenderer: (p) => (p.value ? `<span class="chip ${STATUS_CLS[p.value] || 'off'}">${esc(t(narrow ? { 'Owed to you': 'Owed', 'Paid back': 'Back' }[p.value] || p.value : p.value))}</span>` : '') },
    { field: 'amount', headerName: t('Amount'), filter: 'agNumberColumnFilter', type: 'rightAligned', width: narrow ? 92 : 112, minWidth: 84,
      valueFormatter: (p) => (p.value ? (p.value > 0 ? '+' : '−') + fmt(Math.abs(p.value)) : p.data?.owed ? fmt(p.data.owed) : '—'),
      // A cellClass function replaces the rightAligned type's class, so keep it explicitly.
      cellClass: (p) => ['ag-right-aligned-cell', p.value > 0 ? 'led-in' : p.value < 0 ? 'led-out' : 'led-zero'] },
    { field: 'ref', headerName: t('PayPal reference'), filter: 'agTextColumnFilter', flex: 1, minWidth: 120, hide: narrow, cellClass: 'led-ref', tooltipField: 'ref' },
  ];
}
async function openActivity() {
  const [data, ag] = await Promise.all([get('/api/me/activity'), loadAgGrid().catch(() => null)]);
  $('#tPaid').textContent = fmt(data.totals.paid);
  $('#tHeld').textContent = fmt(data.totals.held);
  $('#tOwed').textContent = fmt(data.totals.owed);
  $('#tBack').textContent = fmt(data.totals.back);
  $('#ledgerEmpty').hidden = data.rows.length > 0;
  $('#ledger').hidden = !data.rows.length || !ag;
  $('#ledgerCount').textContent = data.rows.length ? tn(data.rows.length, '{n} movement', '{n} movements') : '';
  if (!ag || !data.rows.length) return;
  const narrow = innerWidth < 720;
  if (!ledger) {
    ledger = ag.createGrid($('#ledger'), {
      theme: ledgerTheme(ag),
      columnDefs: ledgerColumns(narrow),
      rowData: data.rows,
      getRowId: (p) => p.data.id,
      domLayout: 'autoHeight',
      rowHeight: 46,
      headerHeight: 38,
      animateRows: true,
      defaultColDef: { sortable: true, resizable: true, suppressHeaderMenuButton: false, floatingFilter: false },
      rowSelection: undefined,
      onRowClicked: (e) => e.data?.missionId && openMission(e.data.missionId),
      onFilterChanged: () => {
        const n = ledger.getDisplayedRowCount();
        $('#ledgerCount').textContent = t('{n} of {total}', { n, total: data.rows.length });
      },
      overlayNoRowsTemplate: `<span class="led-none">${t('No movement matches this filter.')}</span>`,
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => ledger.setGridOption('theme', ledgerTheme(ag)));
    let wasNarrow = narrow;
    addEventListener('resize', () => {
      const n = innerWidth < 720;
      if (n !== wasNarrow) { wasNarrow = n; ledger.setGridOption('columnDefs', ledgerColumns(n)); }
    }, { passive: true });
  } else ledger.setGridOption('rowData', data.rows);
}
// Plain words → grid filters (one small AI call); the chip shows what is applied.
$('#askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#askText').value.trim();
  if (!q || !ledger) return;
  $('#askBtn').disabled = true;
  $('#askForm').classList.add('busy');
  try {
    const r = await post('/api/me/activity/ask', { q });
    ledger.setFilterModel(r.filterModel);
    ledger.setGridOption('quickFilterText', r.quickFilter || '');
    $('#filterText').textContent = r.summary;
    $('#filterChip').hidden = false;
  } catch (err) {
    $('#filterText').textContent = t('Could not understand that. Try other words.');
    $('#filterChip').hidden = false;
  } finally {
    $('#askBtn').disabled = false;
    $('#askForm').classList.remove('busy');
  }
});
$('#filterClear').addEventListener('click', () => {
  ledger?.setFilterModel(null);
  ledger?.setGridOption('quickFilterText', '');
  $('#filterChip').hidden = true;
  $('#askText').value = '';
});
$('#csvBtn').addEventListener('click', () => ledger?.exportDataAsCsv({ fileName: `mandat-activity-${new Date().toISOString().slice(0, 10)}.csv`, columnKeys: ['at', 'mission', 'who', 'what', 'kind', 'status', 'amount', 'ref'],
  processCellCallback: (p) => (p.column.getColId() === 'kind' ? kindLabel(p.value) : p.column.getColId() === 'status' ? t(p.value || '') : p.value instanceof Date ? p.value.toISOString() : p.value) }));

function renderSettings() {
  const u = state.me;
  $('#sPayer').textContent = u.paypal.payerName || u.profile.name || t('PayPal account');
  $('#sPayerMail').textContent = u.paypal.payerEmail || (state.paypalMode === 'sandbox' ? '' : t('Demo account'));
  $('#sVerified').hidden = !u.paypal.verified;
  $('#sMandate').textContent = u.paypal.mandate ? `${t('Active since {date}', { date: new Date(u.paypal.mandate.signedAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }).replace(/^1 /, lang === 'fr' ? '1er ' : '1 ') })} · ${u.paypal.mandate.mode === 'sandbox' ? t('PayPal sandbox') : t('demo')}` : t('Not signed');
  sAutonomy = u.rules.autonomy;
  setSeg('#sAutonomy', sAutonomy);
  $('#sAutonomyHelp').textContent = t(u.autonomyLevels[sAutonomy].help);
  $('#sApproveRow').hidden = sAutonomy !== 'balanced';
  $('#sApprove').value = u.rules.approveAbove;
  $('#sDaily').value = u.rules.dailyCap;
  $('#sMonthly').value = u.rules.monthlyCap;
  $('#sStop').checked = u.frozen;
  $('#pName').value = u.profile.name;
  $('#pEmail').value = u.profile.email;
  $('#pPhone').value = u.profile.phone;
  renderPrefs(u.profile);
  $('#sVoice').checked = u.voice.on;
  $('#sInit').textContent = (u.profile.name || u.paypal.payerName || t('You')).split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  renderPush();
  setSeg('#sLang', chosenLang());
  $('#sKnows').textContent = u.knows || t('Nothing yet.');
  renderPeople(u.profile.people);
  renderMemory(u.memory || []);
}
const KIND_LABEL = { preference: 'Likes', person: 'People', place: 'Places', habit: 'Habits', constraint: 'Rules', fact: 'Facts' };
function renderMemory(list) {
  const box = $('#memList');
  box.innerHTML = '';
  $('#memCount').textContent = list.length ? `${list.length}` : '';
  if (!list.length) return box.append(el('p', 'mem-empty', t('Nothing yet. Mandat learns as you go: your tastes, the people you plan with, the places you love.')));
  const order = Object.keys(KIND_LABEL);
  for (const m of [...list].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || String(b.at).localeCompare(String(a.at)))) {
    const row = el('div', 'mem-row');
    const from = m.from === 'you' ? t('Added by you') : m.fromTitle ? t('Learned in “{title}”', { title: m.fromTitle }) : t('Learned in a mission');
    row.innerHTML = `<span class="mem-kind k-${esc(m.kind)}">${esc(t(KIND_LABEL[m.kind] || 'Facts'))}</span><div class="grow"><b>${esc(m.text)}</b><small>${esc(from)} · ${dayMonth(new Date(m.at))}</small></div><button type="button" aria-label="${esc(t('Forget this'))}">−</button>`;
    row.querySelector('button').addEventListener('click', async () => {
      row.classList.add('leaving');
      state.me = (await fetch('/api/me/memory/' + m.id, { method: 'DELETE', headers: HEADERS }).then((r) => r.json())).user;
      renderMemory(state.me.memory || []);
    });
    box.append(row);
  }
}
$('#memAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#memText').value.trim();
  if (text.length < 3) return;
  try {
    state.me = (await post('/api/me/memory', { text })).user;
    $('#memText').value = '';
    renderMemory(state.me.memory || []);
  } catch (err) {
    const inp = $('#memText');
    inp.setCustomValidity(err.message);
    inp.reportValidity();
    setTimeout(() => inp.setCustomValidity(''), 3000);
  }
});
// Your people: the agent reads this list, so "split it with Sam" reaches Sam's PayPal inbox without asking again.
function renderPeople(people) {
  const g = $('#people');
  g.innerHTML = '';
  if (!people.length) g.append(el('p', 'people-empty', t('Nobody yet. Add the friends you often share a bill with.')));
  people.forEach((p, i) => {
    const row = el('div', 'person-row');
    const initials = p.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    row.innerHTML = `<span class="p-av">${esc(initials)}</span><div class="grow"><b>${esc(p.name)}</b><small>${esc(p.email || t('No email yet'))}</small></div><button type="button" aria-label="${esc(t('Remove'))}">${svg('close')}</button>`;
    row.querySelector('button').addEventListener('click', () => {
      people.splice(i, 1);
      saveProfile({ people });
      renderPeople(people);
    });
    g.append(row);
  });
}
$('#addPerson').addEventListener('click', () => {
  $('#personAdd').hidden = false;
  $('#addPerson').hidden = true;
  $('#paName').focus();
});
$('#personAdd').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#paName').value.trim();
  const email = $('#paEmail').value.trim();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
  const people = state.me.profile.people.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
  people.push({ name, email });
  state.me.profile.people = people;
  renderPeople(people);
  saveProfile({ people });
  $('#personAdd').reset();
  $('#personAdd').hidden = true;
  $('#addPerson').hidden = false;
});

// ---------- Preferences: rows that unfold; tap chips, search, or use your location ----------
const fold1 = (id, open) => { const d = $(id); const on = open ?? !d.classList.contains('open'); d.classList.toggle('open', on); d.querySelector('.disc-row').setAttribute('aria-expanded', String(on)); };
$$('.disc-row').forEach((b) => b.addEventListener('click', () => fold1('#' + b.parentElement.id)));
const splitList = (s) => String(s || '').split(/\s*[,;]\s*/).map((x) => x.trim()).filter(Boolean);
const foldText = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const shortAddr = (label) => label.split(',').slice(0, 2).join(',').trim();
// A chip picker: catalogue chips (translated) plus the person's own words; returns the chosen list.
function chipPicker(box, groups, saved, onChange, filter = '') {
  const chosen = new Set(splitList(saved));
  const known = new Set(groups.flatMap((g) => g.items.map((x) => t(x))));
  const own = [...chosen].filter((x) => !known.has(x));
  const all = (own.length ? [{ title: 'Yours', items: own, raw: true }] : []).concat(groups);
  const q = foldText(filter.trim());
  box.innerHTML = '';
  let shown = 0;
  for (const g of all) {
    const items = g.items.map((x) => (g.raw ? x : t(x))).filter((x) => !q || foldText(x).includes(q));
    if (!items.length) continue;
    if (groups.length > 1 || g.raw) box.append(el('p', 'chips-title', t(g.title)));
    const wrap = el('div', 'chips');
    for (const label of items) {
      const b = el('button', 'ob-chip' + (chosen.has(label) ? ' on' : ''), label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(chosen.has(label)));
      b.addEventListener('click', () => {
        if (chosen.has(label)) chosen.delete(label); else chosen.add(label);
        b.classList.toggle('on', chosen.has(label));
        b.setAttribute('aria-pressed', String(chosen.has(label)));
        onChange([...chosen]);
      });
      wrap.append(b);
      shown++;
    }
    box.append(wrap);
  }
  if (q && !shown) {
    const add = el('button', 'ob-chip add', t('Add “{x}”', { x: filter.trim() }));
    add.type = 'button';
    add.addEventListener('click', () => { chosen.add(filter.trim()); onChange([...chosen], true); });
    box.append(add);
  }
}
let prefTimer;
const savePref = (key, list) => {
  state.me.profile[key] = list.join(', ');
  prefSummary(state.me.profile);
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => saveProfile({ [key]: state.me.profile[key] }), 500);
};
function prefSummary(p) {
  $('#vHome').textContent = p.home?.label ? shortAddr(p.home.label) : t('Not set');
  const d = splitList(p.diet);
  $('#vDiet').textContent = d.length ? d.join(', ') : t('None');
  const l = splitList(p.preferences);
  $('#vLikes').textContent = l.length ? l.join(', ') : t('None yet');
}
function renderPrefs(p) {
  prefSummary(p);
  $('#pHome').value = '';
  $('#pHomeList').innerHTML = '';
  chipPicker($('#pDietChips'), [{ title: 'Diet', items: DIET }], p.diet, (list) => savePref('diet', list));
  drawTastes();
}
function drawTastes() {
  chipPicker($('#pLikesChips'), TASTES, state.me.profile.preferences, (list, added) => {
    savePref('preferences', list);
    if (added) { $('#pLikesFind').value = ''; drawTastes(); }
  }, $('#pLikesFind').value);
}
$('#pLikesFind').addEventListener('input', drawTastes);
$('#pDietMore').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  e.preventDefault();
  const list = splitList(state.me.profile.diet).concat(e.target.value.trim());
  e.target.value = '';
  savePref('diet', list);
  chipPicker($('#pDietChips'), [{ title: 'Diet', items: DIET }], state.me.profile.diet, (l) => savePref('diet', l));
});
// Usual address: your current position (turned into an address), or a search with suggestions.
async function setHome(home) {
  state.me.profile.home = home;
  prefSummary(state.me.profile);
  $('#pHome').value = '';
  $('#pHomeList').innerHTML = '';
  await saveProfile({ home });
}
$('#pLocate').addEventListener('click', async () => {
  const b = $('#pLocate span');
  b.textContent = t('Locating…');
  const l = await locate();
  if (!l) { b.textContent = t('Location not allowed: search your address below'); return; }
  let label = t('My location');
  try { label = (await get(`/api/geo/reverse?lat=${l.lat}&lon=${l.lon}`)).label || label; } catch {}
  await setHome({ label, lat: l.lat, lon: l.lon });
  b.textContent = t('Use my current location');
});
// Address suggestions while typing (first run and Settings): tap one, or press Enter to keep what you typed.
function addressSuggest(input, listSel, onPick) {
  let timer;
  $(input).addEventListener('input', (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    if (q.length < 3) { $(listSel).innerHTML = ''; return; }
    timer = setTimeout(async () => {
      let hits = [];
      try { hits = await get('/api/geo/search?q=' + encodeURIComponent(q) + '&tz=' + encodeURIComponent(TZ)); } catch {}
      if ($(input).value.trim() !== q) return;
      const list = $(listSel);
      list.innerHTML = '';
      for (const h of hits) {
        const li = el('li');
        li.innerHTML = `${svg('pin')}<span><b>${esc(h.title)}</b><small>${esc(h.sub)}</small></span>`;
        li.addEventListener('click', () => { list.innerHTML = ''; onPick({ label: h.label, lat: h.lat, lon: h.lon }); });
        list.append(li);
      }
      if (!hits.length) list.append(el('li', 'none', t('No address found. Press Enter to keep what you typed.')));
    }, 400);
  });
  $(input).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) { e.preventDefault(); $(listSel).innerHTML = ''; onPick({ label: e.target.value.trim() }); }
  });
}
addressSuggest('#pHome', '#pHomeList', setHome);
async function saveProfile(profile) {
  state.me = (await post('/api/me', { profile })).user;
  $('#sKnows').textContent = state.me.knows || t('Nothing yet.');
}
async function saveRules(rules) {
  state.me = (await post('/api/me', { rules })).user;
}
for (const [id, key] of [['#pName', 'name'], ['#pEmail', 'email'], ['#pPhone', 'phone']]) {
  $(id).addEventListener('change', () => saveProfile({ [key]: $(id).value }));
}
segmented('#sAutonomy', (v) => {
  sAutonomy = v;
  $('#sAutonomyHelp').textContent = t(state.me.autonomyLevels[v].help);
  $('#sApproveRow').hidden = v !== 'balanced';
  saveRules({ autonomy: v });
});
for (const [id, key] of [['#sApprove', 'approveAbove'], ['#sDaily', 'dailyCap'], ['#sMonthly', 'monthlyCap']]) {
  $(id).addEventListener('change', () => saveRules({ [key]: Number($(id).value) }));
}
$('#sStop').addEventListener('change', async () => {
  state.me = (await post('/api/me/stop', { stopped: $('#sStop').checked })).user;
});
// ---------- notifications ----------
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
function pushSupport() {
  if (isIOS && !installed) return 'install'; // iPhone: web notifications work once Mandat is on the Home Screen
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'none';
  return Notification.permission === 'denied' ? 'blocked' : 'ok';
}
const urlKey = (b64) => Uint8Array.from(atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function enablePush() {
  if (pushSupport() !== 'ok') return renderPush();
  if ((await Notification.requestPermission()) !== 'granted') return renderPush();
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const { key } = await get('/api/push/key');
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(key) }));
  await post('/api/me/push', { subscription: sub.toJSON() });
  state.me.notifications = 1;
  $('#pushAsk').hidden = true;
  renderPush();
}
async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await post('/api/me/push/off', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  state.me.notifications = 0;
  renderPush();
}
async function renderPush() {
  const why = pushSupport();
  const reg = why === 'ok' ? await navigator.serviceWorker.getRegistration('/sw.js') : null;
  const on = !!(await reg?.pushManager.getSubscription()) && Notification.permission === 'granted';
  $('#sPush').checked = on;
  $('#sPush').disabled = why !== 'ok';
  $('#sPushTestRow').hidden = !on;
  $('#sPushInfo').textContent = t(why === 'install' ? 'On iPhone: Share → Add to Home Screen, then open Mandat from there to turn this on'
    : why === 'blocked' ? 'Blocked for this site. Allow notifications in your browser settings'
    : why === 'none' ? 'This browser cannot receive notifications'
    : on ? 'On for this device, only when something needs you' : 'When a payment needs you, a merchant answers or a friend pays');
}
$('#sPush').addEventListener('change', () => ($('#sPush').checked ? enablePush() : disablePush()).catch(() => renderPush()));
$('#sPushTest').addEventListener('click', async () => {
  await post('/api/me/push/test', {});
  $('#sPushTest').textContent = t('Sent');
  setTimeout(() => ($('#sPushTest').textContent = t('Send a test')), 2000);
});
$('#pushOn').addEventListener('click', () => enablePush().catch(() => {}));
$('#pushLater').addEventListener('click', () => {
  $('#pushAsk').hidden = true;
  try { localStorage.setItem('mandat.pushLater', '1'); } catch {}
});
// A mission screen in the background is not "looking": drop the live stream so notifications can reach you.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.es) { state.es.close(); state.es = null; state.paused = state.mission; }
  else if (!document.hidden && state.paused && state.paused === state.mission && !$('#live').hidden) { state.paused = null; openMission(state.mission); }
});

$('#sVoice').addEventListener('change', async () => {
  state.me = (await post('/api/me', { voice: { on: $('#sVoice').checked } })).user;
});
$('#sForget').addEventListener('click', async () => {
  if (!confirm(t('Forget everything Mandat knows about you? Your PayPal connection and missions stay.'))) return;
  state.me = (await post('/api/me/forget', {})).user;
  renderSettings();
});
$('#sRevoke').addEventListener('click', async () => {
  if (!confirm(t('Revoke the PayPal mandate? Your agent will not be able to hold any deposit.'))) return;
  state.me = (await post('/api/me/mandate/revoke', {})).user;
  mandateView();
});
$('#sLocBtn').addEventListener('click', async () => {
  const l = await locate();
  $('#sLoc').textContent = l ? t('Allowed, used to search around you') : t('Not allowed, your usual address is used');
});
// Interface language: Auto follows the phone; changing it reloads the app.
// Changing the language reloads the app; it comes back to Settings, at the same place.
segmented('#sLang', (v) => {
  if (v === chosenLang()) return;
  try { sessionStorage.setItem('mandat_return', JSON.stringify({ view: 'settings', y: scrollY })); } catch {}
  setLang(v);
});

// ---------- photos ----------
function pickPhoto(onReady) {
  pickPhotos(async (files) => onReady(await shrink(files[0])), false);
}
function pickPhotos(onFiles, multiple = true) {
  const input = $('#photoInput');
  input.value = '';
  input.multiple = multiple;
  input.onchange = () => input.files?.length && onFiles([...input.files]);
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
  if (!SR) return alert(t('Voice input is not supported in this browser. Type instead.'));
  stopSpeaking();
  rec = new SR();
  rec.lang = lang === (navigator.language || '').slice(0, 2) ? navigator.language : lang === 'fr' ? 'fr-FR' : 'en-US';
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
// One button: send when there is text, otherwise talk.
$('#orb').addEventListener('click', () => {
  if ($('#sayText').value.trim() || state.attach.length) return $('#say').requestSubmit();
  if (state.listening) return rec?.stop();
  listen((t) => {
    state.voiceTurn = true;
    $('#sayText').value = '';
    syncComposer();
    send(t);
  });
});
function syncComposer() {
  const has = (!!$('#sayText').value.trim() || state.attach.length > 0) && !state.listening;
  const ta = $('#sayText');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  $('#tray').style.bottom = `calc(${$('#composer').offsetHeight + 22}px + env(safe-area-inset-bottom))`;
  $('#composer').classList.toggle('has-text', has);
  $('#orb').setAttribute('aria-label', has ? t('Send') : t('Talk to Mandat'));
}
$('#sayText').addEventListener('input', syncComposer);
function speak(text, { force = false, onend } = {}) {
  if (!window.speechSynthesis || (!force && !state.me?.voice?.on)) return;
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  const vl = lang; // replies follow the app language
  u.voice = voices.find((v) => v.lang.startsWith(vl) && /premium|enhanced|siri/i.test(v.name)) || voices.find((v) => v.lang.startsWith(vl)) || null;
  u.rate = 1.02;
  u.onstart = () => { state.speaking = true; orbState('speaking'); };
  u.onend = u.onerror = () => { state.speaking = false; orbState('idle'); onend?.(); };
  speechSynthesis.speak(u);
}
function stopSpeaking() {
  if (window.speechSynthesis) speechSynthesis.cancel();
  $$('.msg-actions .on').forEach((x) => { x.classList.remove('on'); x.innerHTML = svg('listen'); });
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
  return new Intl.NumberFormat(locale(), { style: 'currency', currency: cur, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v || 0);
}
// Follow new content only if you are already at the bottom; otherwise offer a "New message" pill.
const nearBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 160;
function add(node, { stick = false } = {}) {
  const follow = stick || nearBottom();
  const t = $('#feed > li.typing');
  if (t) $('#feed').insertBefore(node, t);
  else $('#feed').append(node);
  if (!state.live) return; // replaying history: one jump at the end, not a scroll per item
  if (follow) requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));
  else $('#newPill').hidden = false;
}
function keepBottom() {
  if (nearBottom()) window.scrollTo({ top: document.documentElement.scrollHeight });
}
// The reply being written, word by word.
function streamText(t) {
  if (!state.streamLi) {
    typing(false);
    state.streamLi = el('li', 'say streaming');
    state.streamLi.append(el('p', 'say-text', ''));
    add(state.streamLi);
  }
  const follow = nearBottom();
  state.streamLi.firstChild.textContent += t;
  if (follow) window.scrollTo({ top: document.documentElement.scrollHeight });
}
$('#newPill').addEventListener('click', () => {
  $('#newPill').hidden = true;
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
});
addEventListener('scroll', () => { if (nearBottom()) $('#newPill').hidden = true; }, { passive: true });
function step(text) { return el('li', 'step', text); }

// "…" bubble while the agent works; it always stays last in the feed.
function typing(on) {
  const cur = $('#feed > li.typing');
  if (on && !cur) {
    const li = el('li', 'typing');
    li.setAttribute('aria-label', t('Mandat is working'));
    li.innerHTML = '<i></i><i></i><i></i>';
    $('#feed').append(li);
  } else if (!on && cur) cur.remove();
}

// Light, safe formatting for replies: paragraphs, "- " lists, numbered lists, **bold**, *italic*, links.
function md(text) {
  const inline = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-•*]\s+(.*)$/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || num) {
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { if (list) out.push(`</${list.tag}>`); list = { tag }; out.push(`<${tag}>`); }
      out.push(`<li>${inline((bullet || num)[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list.tag}>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list.tag}>`);
  return out.join('');
}
// Words to read aloud or copy: no formatting marks.
const plain = (t) => String(t).replace(/\*\*|__|`/g, '').replace(/^\s*[-•*]\s+/gm, '').replace(/(^|\s)\*(\S.*?)\*/g, '$1$2');
// An assistant reply, with Copy / Listen / Share under it.
const ICON = {
  copy: '<path d="M8 8V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H16"/><rect x="4" y="8" width="12" height="12" rx="1.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  listen: '<path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  undo: '<path d="M9 7 5 11l4 4"/><path d="M5 11h9a5 5 0 0 1 0 10h-2"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.4"/>',
  route: '<circle cx="6.5" cy="17.5" r="2"/><circle cx="17.5" cy="6.5" r="2"/><path d="M8.5 17.5h6a3 3 0 0 0 0-6h-5a3 3 0 0 1 0-6h6"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4M12 13v5M9.5 15.5h5"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>',
  share: '<path d="M12 15V4M8 7.5 12 3.5l4 4"/><path d="M7 11H6a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 18 11h-1"/>',
};
const svg = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
function sayBubble(text) {
  const li = el('li', 'say');
  const body = el('div', 'say-text md');
  body.innerHTML = md(text);
  li.append(body);
  const bar = el('div', 'msg-actions');
  const btn = (name, label, fn) => {
    const b = el('button');
    b.type = 'button';
    b.innerHTML = svg(name);
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', () => fn(b));
    bar.append(b);
    return b;
  };
  const flash = (b, name) => {
    b.innerHTML = svg('check');
    setTimeout(() => (b.innerHTML = svg(name)), 1400);
  };
  btn('copy', t('Copy'), async (b) => {
    try { await navigator.clipboard.writeText(plain(text)); flash(b, 'copy'); } catch {}
  });
  btn('listen', t('Listen'), (b) => {
    if (b.classList.contains('on')) return stopSpeaking();
    stopSpeaking();
    $$('.msg-actions .on').forEach((x) => { x.classList.remove('on'); x.innerHTML = svg('listen'); });
    b.classList.add('on');
    b.innerHTML = svg('stop');
    speak(plain(text), { force: true, onend: () => { b.classList.remove('on'); b.innerHTML = svg('listen'); } });
  });
  btn('share', t('Share'), async (b) => {
    if (navigator.share) return navigator.share({ title: 'Mandat', text: plain(text) }).catch(() => {});
    try { await navigator.clipboard.writeText(plain(text)); flash(b, 'share'); } catch {}
  });
  li.append(bar);
  return li;
}

// A failed turn: plain words and one way out.
function errorStep(message) {
  const li = el('li', 'step error', /too long/i.test(message) ? t('The AI is slow right now and did not answer.') : t('Mandat couldn’t finish that step.'));
  if (state.last && state.live) {
    const b = el('button', 'retry', t('Try again'));
    b.type = 'button';
    b.addEventListener('click', () => { li.remove(); send(state.last.text, state.last.images); });
    li.append(b);
  }
  return li;
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const HEADERS = { 'X-TZ': TZ, 'X-Lang': lang }; // the server writes notifications and messages in the app language
async function get(url) {
  const r = await fetch(url, { headers: HEADERS });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || t('Request failed'));
  return j;
}
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...HEADERS }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error || t('Request failed')), { code: j.code });
  return j;
}

boot();

// ---------- image viewer: open, zoom, save, copy, share ----------
function openLightbox(src) {
  $('#lbImg').src = src;
  $('#lbSave').href = src;
  $('#lbStage').classList.remove('zoomed');
  $('#lightbox').hidden = false;
  document.body.classList.add('no-scroll');
}
function closeLightbox() {
  $('#lightbox').hidden = true;
  document.body.classList.remove('no-scroll');
}
document.addEventListener('click', (e) => {
  const img = e.target.closest('img.zoomable, .qr-box img');
  if (img) { e.preventDefault(); openLightbox(img.currentSrc || img.src); }
});
$('#lbClose').addEventListener('click', closeLightbox);
$('#lbStage').addEventListener('click', (e) => {
  if (e.target === $('#lbStage')) return closeLightbox();
  $('#lbStage').classList.toggle('zoomed'); // tap / click the image to zoom in and out
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#lightbox').hidden) closeLightbox(); });
async function lbBlob() {
  const r = await fetch($('#lbImg').src);
  return r.blob();
}
$('#lbCopy').addEventListener('click', async () => {
  try {
    const blob = await lbBlob();
    const png = blob.type === 'image/png' ? blob : await new Promise((ok) => { const c = document.createElement('canvas'); const i = $('#lbImg'); c.width = i.naturalWidth; c.height = i.naturalHeight; c.getContext('2d').drawImage(i, 0, 0); c.toBlob(ok, 'image/png'); });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    $('#lbCopy').textContent = t('Copied');
  } catch { $('#lbCopy').textContent = t('Not supported'); }
  setTimeout(() => ($('#lbCopy').textContent = t('Copy')), 1400);
});
$('#lbShare').addEventListener('click', async () => {
  try {
    const blob = await lbBlob();
    const file = new File([blob], 'mandat-image.' + (blob.type.split('/')[1] || 'jpg'), { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file] });
  } catch {}
  $('#lbSave').click();
});
