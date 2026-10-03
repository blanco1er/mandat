// Agenda tab: everything Mandat has planned, in one Bryntum Calendar.
//
// The agent drives the schedule. Each dated step of each mission is an event, one colour per mission; steps
// still waiting for a merchant or for the user are drawn dashed. The user does not edit an event by hand:
// moving or stretching one asks Mandat, in that mission's conversation, to move the booking with the
// merchant ("move the photographer to Saturday 14:00"). Mandat renegotiates, updates the plan, and the new
// time comes back here. A click opens the mission.
const CDN = 'https://cdn.jsdelivr.net/npm/@bryntum/calendar-trial@7.3.7';

const WORDS = {
  en: {
    move: (what, when) => `Please move "${what}" to ${when}. Check with the merchant, and tell me if the price or anything else changes.`,
    resize: (what, from, to) => `Please change "${what}" to ${from} – ${to}. Check with the merchant, and tell me if the price changes.`,
    asked: 'Mandat is asking the merchant. The new time shows here once it is confirmed.',
    waiting: 'Waiting for an answer', empty: 'Nothing dated yet. When Mandat books something, it appears here.',
    allDay: 'All day', upcoming: (n) => `${n} booking${n > 1 ? 's' : ''}`,
    status: { confirmed: 'Confirmed', held: 'Deposit held', requested: 'Asked', awaiting_approval: 'To approve', negotiating: 'Negotiating', searching: 'Searching', pending: 'Asked' },
  },
  fr: {
    move: (what, when) => `Décaler « ${what} » au ${when}, en voyant avec le prestataire. Me dire si le prix ou autre chose change.`,
    resize: (what, from, to) => `Changer « ${what} » pour ${from} – ${to}, en voyant avec le prestataire. Me dire si le prix change.`,
    asked: 'Mandat le demande au prestataire. Le nouvel horaire s’affiche ici dès qu’il est confirmé.',
    waiting: 'En attente de réponse', empty: 'Rien de daté pour l’instant. Dès que Mandat réserve, ça apparaît ici.',
    allDay: 'Journée', upcoming: (n) => `${n} rendez-vous`,
    status: { confirmed: 'Confirmé', held: 'Acompte bloqué', requested: 'Demandé', awaiting_approval: 'À valider', negotiating: 'En négociation', searching: 'En recherche', pending: 'Demandé' },
  },
};

let ready;
function css(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
}
function loadCalendar(lang) {
  return (ready ||= new Promise((ok, ko) => {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    [`${CDN}/calendar.css`, `${CDN}/svalbard-${dark ? 'dark' : 'light'}.css`, `${CDN}/fontawesome/css/fontawesome.css`, `${CDN}/fontawesome/css/solid.css`].forEach(css);
    const s = document.createElement('script');
    s.src = `${CDN}/calendar.umd.js`;
    s.onload = () => {
      const B = window.bryntum?.calendar;
      if (!B) return ko(new Error('Calendar missing'));
      if (lang !== 'fr') return ok(B);
      const l = document.createElement('script');
      l.src = `${CDN}/locales/calendar.locale.FrFr.js`;
      l.onload = () => { try { B.LocaleManager.applyLocale('FrFr'); } catch {} ok(B); };
      l.onerror = () => ok(B);
      document.head.append(l);
    };
    s.onerror = () => { ready = null; ko(new Error('Calendar unavailable')); };
    document.head.append(s);
  }));
}

const PENDING = new Set(['searching', 'negotiating', 'requested', 'awaiting_approval', 'pending']);

export async function mountAgenda(el, { get, post, lang, onOpen, onAsked }) {
  const W = WORDS[lang] || WORDS.en;
  const [B, data] = await Promise.all([loadCalendar(lang), get('/api/me/agenda')]);
  const narrow = innerWidth < 720;
  const loc = lang === 'fr' ? 'fr-FR' : 'en-GB';
  const when = (d) => d.toLocaleString(loc, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const hour = (d) => d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  // Open on the next thing that is planned (or today).
  const now = new Date();
  const next = data.events.map((e) => new Date(e.startDate)).filter((d) => d >= new Date(now.toDateString())).sort((a, b) => a - b)[0] || now;
  const asked = new Set();
  const shape = (e) => ({ ...e, cls: PENDING.has(e.status) ? 'mandat-pending' : '', draggable: !e.allDay, resizable: !e.allDay });

  const several = data.missions.length > 1;
  const price = (r) => (r.total ? Number(r.total).toLocaleString(loc, { style: 'currency', currency: r.currency || 'EUR', maximumFractionDigits: Number(r.total) % 1 ? 2 : 0 }) : '');
  const state = (r) => (r.status === 'confirmed' || r.status === 'held' ? 'ok' : 'wait');
  // One booking per row: who (in bold), then what was booked, the price and the mission, and where it stands.
  const card = ({ eventRecord: r, renderData }) => {
    renderData.showBullet = false;
    const title = r.where || r.name;
    const sub = [r.where ? r.name : '', price(r), several ? r.mission : ''].filter(Boolean).join(' · ');
    return {
      className: 'm-ev',
      children: [
        { className: 'm-ev-title', text: title },
        { className: 'm-ev-sub', children: [{ tag: 'span', className: `m-ev-state ${state(r)}`, text: W.status[r.status] || r.status }, sub ? { tag: 'span', text: ' · ' + sub } : null].filter(Boolean) },
      ],
    };
  };
  const times = (r) => (r.allDay ? { className: 'm-ev-time', text: W.allDay } : { className: 'm-ev-time', children: [{ tag: 'b', text: hour(r.startDate) }, { tag: 'span', text: hour(r.endDate) }] });
  const cal = new B.Calendar({
    appendTo: el,
    date: next,
    mode: narrow ? 'agenda' : 'week',
    sidebar: narrow ? false : { items: { datePicker: { showEvents: 'dots' } } },
    resources: data.missions,
    events: data.events.map(shape),
    modes: {
      day: { eventRenderer: ({ eventRecord: r }) => `${r.where ? r.where + ' · ' : ''}${r.name}` },
      week: true,
      month: true,
      year: false,
      agenda: {
        range: 'year',
        settingsButton: null,
        eventHeight: 58,
        eventRenderer: card,
        eventTimeRenderer: times,
        descriptionRenderer: (view) => `${view.date.getFullYear()} · ${W.upcoming(cal.eventStore.count)}`,
      },
    },
    features: {
      eventEdit: false, // times change through Mandat, never behind the merchant's back
      eventMenu: false,
      scheduleMenu: false,
      drag: { creatable: false },
      eventTooltip: {
        renderer: ({ eventRecord: r }) => {
          const enc = B.StringHelper.encodeHtml;
          return `<b>${enc(r.name)}</b><br>${enc(r.where || '')}${r.total ? ` · ${Number(r.total).toLocaleString(loc, { style: 'currency', currency: r.currency || 'EUR' })}` : ''}${PENDING.has(r.status) ? `<br><i>${enc(W.waiting)}</i>` : ''}`;
        },
      },
    },
    listeners: {
      // The move becomes a request to Mandat; the event shows where it was asked to go, dashed, until the
      // merchant confirms and the plan comes back with the real time.
      beforeDragMoveEnd: ({ eventRecord: r, newStartDate }) => { ask(r, W.move(r.name, when(newStartDate))); return true; },
      beforeDragResizeEnd: ({ eventRecord: r, newStartDate, newEndDate }) => { ask(r, W.resize(r.name, when(newStartDate), hour(newEndDate))); return true; },
      eventClick: ({ eventRecord: r }) => onOpen?.(r.resourceId),
    },
  });
  function ask(r, text) {
    asked.add(r.id);
    r.cls = 'mandat-pending mandat-asked';
    // if the request cannot be sent, the event goes back to where it really is
    post(`/api/missions/${r.resourceId}/messages`, { text }).then(() => onAsked?.(W.asked), (e) => { onAsked?.(e.message); api.refresh().catch(() => {}); });
  }
  const empty = document.createElement('p');
  empty.className = 'agenda-empty';
  empty.textContent = W.empty;
  empty.hidden = data.events.length > 0;
  el.after(empty);
  const api = {
    cal,
    destroy() { cal.destroy(); empty.remove(); },
    async refresh() {
      const d = await get('/api/me/agenda');
      cal.resourceStore.data = d.missions;
      cal.eventStore.data = d.events.map(shape);
      empty.hidden = d.events.length > 0;
    },
  };
  return api;
}
