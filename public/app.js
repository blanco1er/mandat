// Mandat — client. Welcome (PayPal login) → mandate → missions → a mission live; settings.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = { me: null, mission: null, es: null, currency: 'EUR', speaking: false, listening: false, cards: {}, verified: {}, photo: null, voiceTurn: false, live: false };
const fmt = (v) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: state.currency, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v || 0);
const PLURAL = { bakery: 'bakeries', florist: 'florists', restaurant: 'restaurants', hotel: 'hotels', bar: 'bars', cafe: 'cafés', hairdresser: 'hair salons', cinema: 'cinemas' };
const many = (c) => PLURAL[c] || c + 's';

// ---------- routing ----------
const VIEWS = ['welcome', 'mandate', 'home', 'live', 'activity', 'settings'];
function show(view) {
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
  if (view !== 'live') $('#topTitle').textContent = 'Mandat';
  $$('#tabbar button').forEach((b) => (b.dataset.tab === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  window.scrollTo({ top: 0 });
  if (view === 'home') requestAnimationFrame(placePill);
  requestAnimationFrame(() => placeLens());
}

history.scrollRestoration = 'manual'; // every screen opens at its top
async function boot() {
  const r = await get('/api/me');
  state.me = r.user;
  state.paypalMode = r.paypalMode;
  $('#demoNote').textContent = r.paypalMode === 'sandbox' ? 'PayPal sandbox — no real money moves.' : 'Demo mode — PayPal sandbox keys not configured yet.';
  const p = new URLSearchParams(location.search);
  history.replaceState(null, '', '/');
  if (!state.me.paypal.mandate) return p.get('mandate') === 'cancelled' ? mandateView() : show('welcome');
  renderHome(r.missions);
  navigator.serviceWorker?.register('/sw.js').catch(() => {});
  const open = p.get('mission');
  if (open) openMission(open);
  else show('home');
}

// ---------- mandate (signing it is also the PayPal sign-in) ----------
$('#start').addEventListener('click', () => mandateView());
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
// ---------- home: one place to ask, then missions sorted by what needs you ----------
const IDEAS = [
  { e: '🧳', t: 'Weekend away', d: 'Hotel, train and a plan', b: 600, q: 'A weekend in Lisbon for two in November, leaving from Paris. A nice hotel near the center and one good dinner.' },
  { e: '🎂', t: 'Birthday evening', d: 'Table, cake, flowers', b: 300, q: "My partner's birthday this Saturday: dinner for 6 around 8pm near me, a cake and flowers." },
  { e: '🧾', t: 'Split a bill', d: 'Everyone pays their share', b: 150, q: 'Dinner came to 128 euros and I paid. Split it with Sam, Lina and Tom.' },
  { e: '🔧', t: 'Get something fixed', d: 'Snap a photo, done', b: 80, q: 'My bike has a flat tyre. Find a repair shop near me that can fix it today.' },
  { e: '💐', t: 'Send flowers', d: 'Delivered with a note', b: 70, q: 'Flowers delivered to my mum on Sunday morning, something cheerful, with a short note from me.' },
  { e: '🇪🇸', t: 'Two weeks in Spain', d: 'Trains, stays, budget kept', b: 700, q: 'Two weeks in Spain in October, I leave from Paris. 700 euros all in.' },
];
const EMOJI = [[/spain|españa|espagne|lisbon|travel|trip|voyage|vacation|weekend/i, '🧳'], [/birthday|anniversaire/i, '🎂'], [/split|share|bill|addition/i, '🧾'], [/dinner|restaurant|dîner|table/i, '🍽️'], [/repair|fix|tyre|tire|répar/i, '🔧'], [/hair|coiff/i, '💇'], [/concert|ticket|billet/i, '🎟️'], [/flower|fleur/i, '💐'], [/hotel|hôtel/i, '🛎️']];
const compose = { budget: 400, auto: false, touched: false, emoji: null, photos: [], voice: false };

// Ideas: tapping one fills the box — it never starts anything by itself.
for (const i of IDEAS) {
  const b = el('button', 'idea');
  b.type = 'button';
  b.innerHTML = `<span aria-hidden="true">${i.e}</span>${esc(i.t)}`;
  b.title = i.d;
  b.addEventListener('click', () => {
    $('#cText').value = i.q;
    compose.emoji = i.e;
    setBudget(i.b, { auto: false, touched: false }); // an amount you then type still wins
    onCompose();
    $('#cText').focus();
    $('#cText').setSelectionRange(i.q.length, i.q.length);
  });
  $('#ideas').append(b);
}

// A rotating example in the empty box, typed in softly.
const HINTS = ['Book a table for 4 tonight, around 40 € each…', 'Two weeks in Spain, 700 € all in…', 'Get my bike fixed today…', 'Split last night’s dinner with Sam and Lina…'];
let hintI = 0, hintTimer;
function typeHint() {
  const box = $('#cText');
  if (box.value || document.activeElement === box) return (box.placeholder = 'Say what you need and what you can spend…');
  const h = HINTS[hintI++ % HINTS.length];
  let n = 0;
  clearInterval(hintTimer);
  hintTimer = setInterval(() => {
    box.placeholder = h.slice(0, ++n);
    if (n >= h.length) clearInterval(hintTimer);
  }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 28);
}
setInterval(typeHint, 4200);

// The budget is read from your words ("700 euros", "€50 each") unless you set it yourself.
function budgetFromText(t) {
  const m = t.match(/(?:€|eur\s?)\s?(\d[\d\s.,]*)|(\d[\d\s.,]*)\s?(?:€|euros?|eur\b)/i);
  if (!m) return null;
  const n = Number((m[1] || m[2]).replace(/\s/g, '').replace(/,(\d{1,2})$/, '.$1').replace(/,/g, ''));
  return n > 0 && n < 100000 ? Math.round(n) : null;
}
function setBudget(v, { auto = false, touched = compose.touched } = {}) {
  compose.budget = v;
  compose.auto = auto;
  compose.touched = touched;
  $('#cBudget').textContent = fmtC(v);
  $('#cBudgetAuto').hidden = !auto;
  $('#cBudgetIn').value = v;
  $$('#cChips button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === v));
}
function onCompose() {
  const t = $('#cText').value;
  const found = budgetFromText(t);
  if (found && !compose.touched) setBudget(found, { auto: true, touched: false });
  // One button, as in a mission: the voice orb while empty, the send arrow as soon as there is something.
  const has = !!t.trim() || compose.photos.length > 0;
  $('#compose').classList.toggle('has-text', has);
  $('#cGo').setAttribute('aria-label', has ? 'Start mission' : 'Talk to Mandat');
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
function toggleBudget(open = $('#cBudgetEdit').hidden) {
  $('#cBudgetEdit').hidden = !open;
  $('#cBudgetBtn').setAttribute('aria-expanded', String(open));
}
$('#cBudgetBtn').addEventListener('click', () => toggleBudget());
$('#cBudgetIn').addEventListener('input', () => {
  const v = Math.round(Number($('#cBudgetIn').value.replace(',', '.')));
  if (v > 0) setBudget(v, { touched: true });
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
    const t = el('div', 'tray-item');
    t.innerHTML = `<img src="${src}" alt="Photo ${i + 1}"><button type="button" aria-label="Remove photo ${i + 1}">✕</button>`;
    t.querySelector('img').addEventListener('click', () => openLightbox(src));
    t.querySelector('button').addEventListener('click', () => { compose.photos.splice(i, 1); drawComposeThumbs(); onCompose(); });
    box.append(t);
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
    const emoji = compose.emoji || EMOJI.find(([re]) => re.test(intent))?.[1] || '✦';
    const r = await post('/api/missions', { intent, budget: compose.budget, emoji, location, images: compose.photos });
    state.voiceTurn = compose.voice;
    resetCompose();
    openMission(r.id);
  } catch (err) {
    $('#cRule').textContent = err.message;
    $('#cRule').classList.add('error');
  } finally {
    $('#compose').classList.remove('sending');
    onCompose();
  }
});
function resetCompose() {
  $('#cText').value = '';
  Object.assign(compose, { emoji: null, photos: [], voice: false, auto: false, touched: false });
  drawComposeThumbs();
  setBudget(400);
  toggleBudget(false);
  onCompose();
}
function ruleText() {
  const lvl = state.me.rules.autonomy;
  return lvl === 'autopilot' ? 'Autopilot · books and holds deposits on its own, inside this budget.' : lvl === 'careful' ? 'Careful · asks you before every payment.' : `Balanced · asks you before any payment over ${fmtC(state.me.rules.approveAbove)}.`;
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
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' }); // the interface is in English: no mixed languages
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  for (const [u, n] of [['minute', 60], ['hour', 3600], ['day', 86400], ['week', 604800]]) if (s < n * (u === 'week' ? 5 : u === 'day' ? 7 : u === 'hour' ? 24 : 60)) return rtf.format(-Math.floor(s / n), u);
  return new Date(t).toLocaleDateString('en', { day: 'numeric', month: 'short' });
}
function renderHome(missions) {
  state.missions = missions;
  const name = (state.me.profile.name || state.me.paypal.payerName || '').split(' ')[0];
  const h = new Date().getHours();
  $('#hello').textContent = `${h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}${name ? ', ' + name : ''}`;
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
  else list.append(el('p', 'm-empty', q ? 'No mission matches.' : MTABS[state.mtab].empty));
  // Archived missions sit, folded, at the bottom of "Done".
  const archived = all.filter((m) => m.archived);
  if (!q && state.mtab === 'done' && archived.length) {
    const t = el('button', 'm-archived-toggle', `${state.showArchived ? 'Hide' : 'Show'} archived (${archived.length})`);
    t.type = 'button';
    t.addEventListener('click', () => { state.showArchived = !state.showArchived; drawList(); });
    list.append(t);
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
const cleanTitle = (t) => String(t || 'Mission').replace(/[\s,;:.\-–]+$/, '');
function missionLine(m) {
  if (m.status === 'needs_you') return ['needs', m.needs || 'Waiting for you'];
  if (m.status === 'working') return ['working', 'Working on it'];
  if (m.status === 'waiting') return ['quiet', m.needs];
  if (m.status === 'done') return ['quiet', m.held ? `All booked · ${fmtC(m.held, m.currency)} held until confirmed` : 'All booked'];
  if (m.status === 'stopped') return ['quiet', 'Paused — no payment can be made'];
  return ['quiet', m.last || 'Starting…'];
}
// One compact row per mission: icon · title · what is going on · when · money left.
function missionRow(m) {
  const li = el('li', 'm-row');
  li.dataset.id = m.id;
  const [cls, line] = missionLine(m);
  li.innerHTML = `<span class="m-ic">${esc(m.emoji)}</span>
    <div class="m-txt"><div class="m-l1"><b>${esc(cleanTitle(m.title))}</b><time>${ago(m.lastAt)}</time></div>
      <div class="m-l2"><span class="m-line ${cls}">${esc(line)}</span><span class="m-left">${fmtC(m.remaining, m.currency)} left</span></div></div>
    <button type="button" class="m-more" aria-label="More for ${esc(m.title)}" aria-haspopup="menu"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>`;
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
  item(m.archived ? 'Move back to missions' : 'Archive', async () => { await post(`/api/missions/${m.id}/archive`, { archived: !m.archived }); refreshHome(); });
  if (!m.held) item('Delete…', async () => {
    if (!confirm(`Delete “${m.title}”? Its conversation will be gone.`)) return;
    const r = await fetch(`/api/missions/${m.id}`, { method: 'DELETE' });
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
setBudget(400);
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
    const t = el('div', 'tray-item');
    t.innerHTML = `<img src="${src}" alt="Photo ${i + 1} to send"><button type="button" aria-label="Remove photo ${i + 1}">✕</button>`;
    t.querySelector('img').addEventListener('click', () => openLightbox(src));
    t.querySelector('button').addEventListener('click', () => { state.attach.splice(i, 1); renderTray(); syncComposer(); });
    tray.append(t);
  });
  if (state.attach.length && state.attach.length < 4) {
    const more = el('button', 'tray-add', '+');
    more.type = 'button';
    more.setAttribute('aria-label', 'Add another photo');
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
          im.alt = 'Photo you sent';
          im.loading = 'lazy';
          g.append(im);
        }
        li.append(g);
      } else if (data.image) li.append(el('span', 'u-legacy', '📷 Photo'));
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
    case 'title': $('#topTitle').textContent = data.title; return;
    case 'busy': state.busy = data.on; if (!data.on) closeSteps(); typing(data.on); return orbState(data.on ? 'thinking' : state.speaking ? 'speaking' : 'idle');
    case 'tool': typing(state.busy); return toolStep(data);
    case 'places': return placesCard(data);
    case 'preview': return previewCard(data);
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
      return add(step(`${data.friend} paid their share — ${fmt(data.amount)}`));
    }
    case 'stopped': return add(step(data.stopped ? 'Stopped — no payment will be made until you resume.' : 'Resumed.'));
    case 'error': return add(errorStep(data.message));
  }
}

const TOOL_LABEL = {
  show_place_preview: (a) => `Looking up ${a.name}`,
  find_real_places: (a) => `Looking for real ${many(a.category)} nearby`,
  find_network_merchants: (a) => `Checking ${many(a.category)} I can book and pay`,
  cancel_hold: () => 'Releasing a hold',
  split_bill: () => 'Preparing PayPal links for your friends',
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
    if (n > 1) g.querySelector('.steps-label').textContent = `Worked through ${n} steps`;
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
  li.innerHTML = `<header><span class="avatar" style="background:#19a463">⌖</span><div><b>${places.length} real ${many(category)} nearby</b><small>${esc(places.slice(0, 2).map((p) => p.name).join(', '))}${places.length > 2 ? '…' : ''} · map</small></div></header>
    ${shown.length ? `<div class="place-map" role="region" aria-label="Map of ${esc(many(category))} nearby"></div>` : ''}
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
        .setHTML(`<b>${esc(p.name)}</b><span>${p.distance} m away</span><a href="https://maps.apple.com/?daddr=${p.lat},${p.lon}" target="_blank" rel="noopener">Directions</a>`)
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
  const meta = [v.rating ? `★ ${v.rating.toFixed(1)}${v.ratings ? ` (${v.ratings.toLocaleString('en')})` : ''}` : '', v.cuisine || v.category, v.distance != null ? `${v.distance} m` : '', v.openingHours ? v.openingHours.slice(0, 40) : ''].filter(Boolean).map(esc).join(' · ');
  li.innerHTML = `${photos.length
    ? `<div class="pv-photos">${photos.map((p) => `<img class="zoomable" src="${esc(p.url)}" alt="${esc(v.name)}" loading="lazy" referrerpolicy="no-referrer">`).join('')}</div>`
    : `<div class="pv-none"><span>📍</span><small>No public photo yet — open Google Maps for people's photos</small></div>`}
    <div class="pv-body"><b>${esc(v.name)}</b><small>${meta}</small>${v.address ? `<small>${esc(v.address)}</small>` : ''}
      <div class="pv-actions"><a class="pill-btn" href="${esc(v.googleMaps)}" target="_blank" rel="noopener">Photos on Google Maps</a>${v.directions ? `<a href="${esc(v.directions)}" target="_blank" rel="noopener">Directions</a>` : ''}${v.website ? `<a href="${esc(/^https?:/.test(v.website) ? v.website : 'https://' + v.website)}" target="_blank" rel="noopener">Website</a>` : ''}</div>
      ${photos.length ? `<p class="pv-src">Photos: ${esc([...new Set(photos.map((p) => p.source))].join(', '))}</p>` : ''}</div>`;
  // A photo that cannot load disappears instead of leaving a broken frame.
  li.querySelectorAll('.pv-photos img').forEach((im) => im.addEventListener('error', () => { im.remove(); if (!li.querySelector('.pv-photos img')) li.querySelector('.pv-photos')?.remove(); }));
  add(li);
}
function verifiedMark({ merchant_id, name, ok }) {
  state.verified[merchant_id] = ok;
  const card = state.cards['n:' + merchant_id];
  if (card) card.querySelector('.shield').hidden = !ok;
  addStep(`${name} — identity ${ok ? 'verified' : 'could not be verified'}`);
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
  card.querySelector('.sub').textContent = offer?.total ? `Offer ${fmt(offer.total)}${offer.discount ? ` · −${fmt(offer.discount)}` : ''} · ${n} messages` : `Negotiating with their AI agent · ${n} message${n > 1 ? 's' : ''}`;
  fold(card);
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
  const [label, cls] = { accepted: ['Accepted', 'wait'], confirmed: ['Confirmed', 'paid'], declined: ['Declined', 'off'], countered: ['Other time', 'part'] }[r.status] || ['Waiting', 'wait'];
  const sub = r.status === 'pending' ? 'No AI agent · request sent to their inbox' : r.status === 'countered' ? `Proposes ${esc(r.counterSlot)} instead` : r.status === 'accepted' ? 'Accepted · confirms when the deposit is held' : r.status === 'confirmed' ? 'Confirmed · deposit paid with PayPal' : 'Declined';
  card.innerHTML = `<header><span class="avatar m">${esc(r.merchant[0])}</span><div><b>${esc(r.merchant)}</b><small>${sub}</small></div><span class="chip ${cls}">${label}</span></header>
    <p>${r.items.map((i) => `${i.qty}× ${esc(i.label)}`).join(', ')}${r.slot ? ' · ' + esc(r.slot) : ''} — ${fmt(r.total)}, deposit ${fmt(r.deposit)}</p>${r.reply ? `<p class="req-reply">“${esc(r.reply)}”</p>` : ''}
    ${r.inbox && (r.status === 'pending' || r.status === 'accepted') ? `<a class="inbox-link" href="${esc(r.inbox)}" target="_blank" rel="noopener">See it from ${esc(r.merchant)}'s side (demo inbox) ↗</a>` : ''}`;
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
  const [icon, title, sub] = kind === 'hold' ? ['🔒', 'Held with PayPal', 'Not charged until the merchant confirms']
    : kind === 'capture' ? ['✓', 'Paid with PayPal', why ? why + ' · deposit captured' : 'Merchant confirmed · deposit captured']
    : ['↩︎', 'Refunded with PayPal', reason || 'Back to your PayPal'];
  li.innerHTML = `<header><span class="lock">${icon}</span><div class="pay-main"><b>${title.replace(' with PayPal', '')} · ${esc(entry.merchant)}</b></div><span class="amt">${kind === 'refund' ? '+' : ''}${fmt(entry.amount)}</span></header>
    <div class="pay-detail"><p>${esc(shortLabel(entry.merchant, entry.label))}</p><p class="why">${esc(sub)} · PayPal${mode === 'sandbox' ? ' sandbox' : mode ? ' (demo)' : ''}</p></div>`;
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
    if (d === 'later') return 'To schedule';
    const dt = new Date(d + 'T12:00:00');
    const n = first ? Math.round((dt - new Date(first + 'T12:00:00')) / 864e5) + 1 : 0;
    return `${dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}${n > 0 && groups.length > 1 ? ` · Day ${n}` : ''}`;
  };
  const planned = items.filter((i) => i.status !== 'cancelled' && i.total > 0).reduce((t, i) => t + i.total, 0);
  const budget = state.envTotal || 0;
  const multiDay = groups.filter((g) => g.key !== 'later').length > 1;
  const booked = items.filter((i) => i.status === 'confirmed' || i.status === 'held').length;
  card.innerHTML = `<header><span class="avatar" style="background:var(--accent)">✦</span><div><b>${multiDay ? 'Your trip, day by day' : 'Your plan'}</b><small>${booked}/${items.length} booked${planned ? ` · ${fmt(planned)}${budget ? ' of ' + fmt(budget) : ''}` : ''}</small></div></header>
    <div class="timeline">${groups.map((g) => `<section class="tl-day"><h3>${label(g.key)}</h3>${g.items.map((it) => {
      const [st, cls] = PLAN_STATUS[it.status] || [it.status, 'off'];
      const time = /\d{2}:\d{2}/.test(it.when || '') ? it.when.match(/\d{2}:\d{2}/)[0] : !it.d && it.when ? it.when : '';
      return `<div class="tl-item ${it.status === 'cancelled' ? 'off' : ''}"><span class="tl-ic">${KIND[it.kind] || (/(train|flight|bus|→)/i.test(it.what) ? '🚆' : /(night|hostel|hotel|room|stay)/i.test(it.what) ? '🛏️' : '•')}</span>
        <div class="tl-main"><b>${esc(it.what)}${it.nights ? ` · ${it.nights} night${it.nights > 1 ? 's' : ''}` : ''}</b><small>${[it.merchant, time].filter(Boolean).map(esc).join(' · ')}</small></div>
        <div class="tl-side">${it.total ? `<span class="tl-amt">${fmt(it.total)}</span>` : ''}<span class="chip ${cls}">${st}</span></div></div>`;
    }).join('')}</section>`).join('')}</div>
    ${planned ? `<div class="tl-total"><span>Planned ${fmt(planned)}${budget ? ` of ${fmt(budget)}` : ''}</span>${budget ? `<span class="${planned > budget ? 'over' : ''}">${planned > budget ? 'Over by ' + fmt(planned - budget) : fmt(budget - planned) + ' left for food & extras'}</span>` : ''}</div>
    <div class="tl-bar"><i style="width:${budget ? Math.min(100, (100 * planned) / budget) : 0}%"></i></div>` : ''}`;
  fold(card);
  if (!card.isConnected) add(card);
}
// Split bill: one real PayPal invoice per friend — emailed by PayPal, plus a pay link and a QR code.
const SHARE_STATUS = { PAID: ['Paid', 'paid'], PARTIALLY_PAID: ['Part paid', 'part'], CANCELLED: ['Cancelled', 'off'], REFUNDED: ['Refunded', 'off'] };
function shareChip(chip, status, mode) {
  const [text, cls] = mode === 'offline' ? ['Demo', 'off'] : SHARE_STATUS[status] || ['Waiting', 'wait'];
  chip.textContent = text;
  chip.className = 'chip ' + cls;
}
function splitDetails(b) {
  if (!b) return '';
  const when = b.date ? new Date(b.date + 'T12:00:00').toLocaleDateString('en', { day: 'numeric', month: 'short' }) : '';
  const payer = b.people.find((p) => p.payer);
  return `<details class="split-how"><summary>How it was split</summary>
    <p class="split-paid">${esc(payer?.name || 'You')} paid <b>${fmt(b.total)}</b>${b.where ? ` at ${esc(b.where)}` : ''}${when ? ` · ${when}` : ''}</p>
    ${b.items?.length ? `<ul class="split-lines">${b.items.map((i) => `<li><span>${esc(i.name)}</span><span>${fmt(i.total)}</span></li>`).join('')}</ul>` : ''}
    <ul class="split-lines people">${b.people.map((p) => `<li><span>${esc(p.name)}${p.payer ? ' <em>paid</em>' : ''}</span><span>${fmt(p.amount)}</span></li>`).join('')}</ul>
    <p class="split-note">${b.equal ? `Split equally between ${b.people.length} people.` : 'Unequal split, as you asked.'}${b.rounding ? ` ${esc(b.rounding.name)} covers the extra ${fmt(b.rounding.amount)} from rounding.` : ''} Each invoice lists these lines and the person's own part.</p>
  </details>`;
}
function sharesCard({ label, per, links, breakdown }) {
  const li = el('li', 'card split');
  li.innerHTML = `<header><span class="avatar" style="background:#7b61ff">👥</span><div><b>Split · ${esc(label)}</b><small class="split-sum">${breakdown ? fmt(breakdown.total) + ' · ' : ''}${links.length} invoice${links.length > 1 ? 's' : ''} sent</small></div></header>
    ${splitDetails(breakdown)}<ul class="split-list"></ul>
    <p class="split-foot">No app needed to pay: from PayPal's email, the link, or the QR code.</p>`;
  const ul = li.querySelector('.split-list');
  for (const l of links) {
    const row = el('li', 'split-row');
    if (l.error) {
      row.innerHTML = `<div class="split-top"><span class="who"><b>${esc(l.friend)}</b><small>Could not create the invoice</small></span><span class="amt">${fmt(l.amount)}</span></div>`;
      ul.append(row);
      continue;
    }
    row.innerHTML = `<span class="who"><b>${esc(l.friend)}</b><small>${l.emailed ? 'Emailed' : 'Link & QR'}</small></span><span class="amt">${fmt(l.amount)}</span><span class="chip"></span>
      <span class="split-actions"><button type="button" data-a="qr" aria-label="Show ${esc(l.friend)}'s QR code">${svg('qr')}</button><button type="button" data-a="share" aria-label="Send ${esc(l.friend)} the link">${svg('share')}</button><button type="button" data-a="copy" aria-label="Copy ${esc(l.friend)}'s pay link">${svg('copy')}</button></span>`;
    shareChip(row.querySelector('.chip'), l.status, l.mode);
    state.shareRows[l.invoiceId] = row;
    const text = `${l.friend}, your share for ${label}: ${fmt(l.amount)}. Pay with PayPal:`;
    row.querySelector('[data-a=qr]').addEventListener('click', () => (l.qr ? openLightbox(l.qr) : alert('No QR code in demo mode.')));
    row.querySelector('[data-a=share]').addEventListener('click', async (e) => {
      if (navigator.share) return navigator.share({ title: 'Your share', text, url: l.payUrl }).catch(() => {});
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
  if (s && chips.length) s.textContent = s.textContent.replace(/ · \d+\/\d+ paid$|$/, ` · ${paid}/${chips.length} paid`);
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
  $('#topSub').textContent = `${fmt(e.remaining)} left of ${fmt(e.total)}${e.held ? ` · ${fmt(e.held)} held` : ''}${e.spent ? ` · ${fmt(e.spent)} paid` : ''}`;
  const p = (v) => (100 * v) / (e.total || 1);
  $('.env-bar .spent').style.width = p(e.spent) + '%';
  $('.env-bar .held').style.width = p(e.held) + '%';
  // Receipts: every payment of this mission with its PayPal reference (shown when the bar is unfolded).
  const RS = { held: ['Held', 'wait'], captured: ['Paid', 'paid'], released: ['Released', 'off'], refunded: ['Refunded', 'part'] };
  $('#receipts').innerHTML = (e.entries || []).length
    ? e.entries.map((x) => {
      const [st, cls] = RS[x.state] || [x.state, 'off'];
      const ref = x.paypal?.captureId || x.paypal?.authorizationId || '';
      return `<li><div><b>${esc(x.merchant)}</b><small>${esc(shortLabel(x.merchant, x.label))}${ref ? ` · <span class="ref">${esc(ref)}</span>` : ''}</small></div><span class="chip ${cls}">${st}</span><span class="r-amt">${fmt(x.amount - (x.refunded || 0))}</span></li>`;
    }).join('')
    : '<li class="none">No payment yet in this mission.</li>';
}

// ---------- approval sheet: hold to approve ----------
let pending = null;
function openSheet(a) {
  if (a.status && a.status !== 'pending') return;
  pending = a;
  $('#sheetMerchant').textContent = `Pay ${a.merchant} (via Mandat)`;
  $('#sheetLines').innerHTML = `<div><span>${esc(a.label)}</span><span>${fmt(a.amount)}</span></div>${a.offer_total ? `<div><span>Booking total</span><span>${fmt(a.offer_total)}</span></div>` : ''}`;
  $('#sheetAmount').textContent = fmt(a.amount);
  $('#sheetFine').textContent = (a.reason ? a.reason + '. ' : '') + 'Held with PayPal, not charged until the merchant confirms. Cancel anytime and it returns to your mission budget.';
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
  card.innerHTML = `<span class="pp-mini">PayPal</span><div class="ap-main"><b>${open ? 'Approve' : d.status === 'approved' ? 'Approved' : 'Declined'} ${fmt(d.amount)}</b><small>${esc(d.merchant)} · ${esc(shortLabel(d.merchant, d.label))}</small></div>${open ? '<button type="button" class="pill-btn">Review</button>' : `<span class="chip ${d.status === 'approved' ? 'paid' : 'off'}">${d.status === 'approved' ? 'Approved' : 'Declined'}</span>`}`;
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
function ledgerColumns(narrow) {
  return [
    { field: 'at', headerName: 'When', filter: 'agDateColumnFilter', sort: 'desc', width: 112, minWidth: 96, hide: narrow,
      valueGetter: (p) => (p.data?.at ? new Date(p.data.at) : null),
      valueFormatter: (p) => (p.value ? p.value.toLocaleDateString('en', { day: 'numeric', month: 'short' }) + ' · ' + p.value.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''),
      filterParams: { comparator: (d, v) => { const x = new Date(v); x.setHours(0, 0, 0, 0); return x < d ? -1 : x > d ? 1 : 0; } } },
    { field: 'who', headerName: narrow ? 'Who' : 'Merchant / friend', filter: 'agTextColumnFilter', flex: 1.2, minWidth: 110,
      // On a phone the date sits under the name, so three columns are enough: who, status, amount.
      cellRenderer: (p) => (p.data ? `<span class="led-who"><span class="led-emoji">${p.data.kind === 'Share' ? '👥' : esc(p.data.emoji)}</span><span class="led-name">${esc(p.value)}${innerWidth < 720 && p.data.at ? `<small>${new Date(p.data.at).toLocaleDateString('en', { day: 'numeric', month: 'short' })}</small>` : ''}</span></span>` : esc(p.value)) },
    { field: 'mission', headerName: 'Mission', filter: 'agTextColumnFilter', flex: 1.2, minWidth: 110, hide: narrow },
    { field: 'what', headerName: 'What', filter: 'agTextColumnFilter', flex: 1.4, minWidth: 110, hide: narrow },
    { field: 'kind', headerName: 'Type', filter: 'agTextColumnFilter', width: 100, hide: narrow },
    { field: 'status', headerName: 'Status', filter: 'agTextColumnFilter', width: narrow ? 84 : 128, minWidth: 76,
      cellRenderer: (p) => (p.value ? `<span class="chip ${STATUS_CLS[p.value] || 'off'}">${esc(narrow ? { 'Owed to you': 'Owed', 'Paid back': 'Back' }[p.value] || p.value : p.value)}</span>` : '') },
    { field: 'amount', headerName: 'Amount', filter: 'agNumberColumnFilter', type: 'rightAligned', width: narrow ? 92 : 112, minWidth: 84,
      valueFormatter: (p) => (p.value ? (p.value > 0 ? '+' : '−') + fmt(Math.abs(p.value)) : p.data?.owed ? fmt(p.data.owed) : '—'),
      // A cellClass function replaces the rightAligned type's class, so keep it explicitly.
      cellClass: (p) => ['ag-right-aligned-cell', p.value > 0 ? 'led-in' : p.value < 0 ? 'led-out' : 'led-zero'] },
    { field: 'ref', headerName: 'PayPal reference', filter: 'agTextColumnFilter', flex: 1, minWidth: 120, hide: narrow, cellClass: 'led-ref', tooltipField: 'ref' },
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
  $('#ledgerCount').textContent = data.rows.length ? `${data.rows.length} movement${data.rows.length > 1 ? 's' : ''}` : '';
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
        $('#ledgerCount').textContent = `${n} of ${data.rows.length}`;
      },
      overlayNoRowsTemplate: '<span class="led-none">No movement matches this filter.</span>',
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
    $('#filterText').textContent = 'Could not understand that — try other words.';
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
$('#csvBtn').addEventListener('click', () => ledger?.exportDataAsCsv({ fileName: `mandat-activity-${new Date().toISOString().slice(0, 10)}.csv`, columnKeys: ['at', 'mission', 'who', 'what', 'kind', 'status', 'amount', 'ref'] }));

function renderSettings() {
  const u = state.me;
  $('#sPayer').textContent = u.paypal.payerName || u.profile.name || 'PayPal account';
  $('#sPayerMail').textContent = u.paypal.payerEmail || (state.paypalMode === 'sandbox' ? '' : 'Demo account');
  $('#sVerified').hidden = !u.paypal.verified;
  $('#sMandate').textContent = u.paypal.mandate ? `Active since ${new Date(u.paypal.mandate.signedAt).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })} · ${u.paypal.mandate.mode === 'sandbox' ? 'PayPal sandbox' : 'demo'}` : 'Not signed';
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
  $('#sInit').textContent = (u.profile.name || u.paypal.payerName || 'You').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  renderPush();
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
  $('#sPushInfo').textContent = why === 'install' ? 'On iPhone: Share → Add to Home Screen, then open Mandat from there to turn this on'
    : why === 'blocked' ? 'Blocked for this site — allow notifications in your browser settings'
    : why === 'none' ? 'This browser cannot receive notifications'
    : on ? 'On for this device — only when something needs you' : 'When a payment needs you, a merchant answers or a friend pays';
}
$('#sPush').addEventListener('change', () => ($('#sPush').checked ? enablePush() : disablePush()).catch(() => renderPush()));
$('#sPushTest').addEventListener('click', async () => {
  await post('/api/me/push/test', {});
  $('#sPushTest').textContent = 'Sent';
  setTimeout(() => ($('#sPushTest').textContent = 'Send a test'), 2000);
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
  $('#orb').setAttribute('aria-label', has ? 'Send' : 'Talk to Mandat');
}
$('#sayText').addEventListener('input', syncComposer);
function speak(text, { force = false, onend } = {}) {
  if (!window.speechSynthesis || (!force && !state.me?.voice?.on)) return;
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  const lang = (navigator.language || 'en').slice(0, 2);
  u.voice = voices.find((v) => v.lang.startsWith(lang) && /premium|enhanced|siri/i.test(v.name)) || voices.find((v) => v.lang.startsWith(lang)) || null;
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
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: cur, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v || 0);
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
  const t = $('#feed > li.typing');
  if (on && !t) {
    const li = el('li', 'typing');
    li.setAttribute('aria-label', 'Mandat is working');
    li.innerHTML = '<i></i><i></i><i></i>';
    $('#feed').append(li);
  } else if (!on && t) t.remove();
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
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>',
  share: '<path d="M12 15V4M8 7.5 12 3.5l4 4"/><path d="M7 11H6a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 18 11h-1"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
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
  btn('copy', 'Copy', async (b) => {
    try { await navigator.clipboard.writeText(plain(text)); flash(b, 'copy'); } catch {}
  });
  btn('listen', 'Listen', (b) => {
    if (b.classList.contains('on')) return stopSpeaking();
    stopSpeaking();
    $$('.msg-actions .on').forEach((x) => { x.classList.remove('on'); x.innerHTML = svg('listen'); });
    b.classList.add('on');
    b.innerHTML = svg('stop');
    speak(plain(text), { force: true, onend: () => { b.classList.remove('on'); b.innerHTML = svg('listen'); } });
  });
  btn('share', 'Share', async (b) => {
    if (navigator.share) return navigator.share({ title: 'Mandat', text: plain(text) }).catch(() => {});
    try { await navigator.clipboard.writeText(plain(text)); flash(b, 'share'); } catch {}
  });
  li.append(bar);
  return li;
}

// A failed turn: plain words and one way out.
function errorStep(message) {
  const li = el('li', 'step error', /too long/i.test(message) ? 'The AI is slow right now and did not answer.' : "Mandat couldn't finish that step.");
  if (state.last && state.live) {
    const b = el('button', 'retry', 'Try again');
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
    $('#lbCopy').textContent = 'Copied';
  } catch { $('#lbCopy').textContent = 'Not supported'; }
  setTimeout(() => ($('#lbCopy').textContent = 'Copy'), 1400);
});
$('#lbShare').addEventListener('click', async () => {
  try {
    const blob = await lbBlob();
    const file = new File([blob], 'mandat-image.' + (blob.type.split('/')[1] || 'jpg'), { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file] });
  } catch {}
  $('#lbSave').click();
});
