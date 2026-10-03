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
  },
  fr: {
    move: (what, when) => `Peux-tu décaler « ${what} » au ${when} ? Vois-le avec le prestataire, et dis-moi si le prix ou autre chose change.`,
    resize: (what, from, to) => `Peux-tu changer « ${what} » pour ${from} – ${to} ? Vois-le avec le prestataire, et dis-moi si le prix change.`,
    asked: 'Mandat le demande au prestataire. Le nouvel horaire s’affiche ici dès qu’il est confirmé.',
    waiting: 'En attente de réponse', empty: 'Rien de daté pour l’instant. Dès que Mandat réserve, ça apparaît ici.',
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

  const cal = new B.Calendar({
    appendTo: el,
    date: next,
    mode: narrow ? 'agenda' : 'week',
    sidebar: narrow ? false : { items: { datePicker: { showEvents: 'dots' } } },
    resources: data.missions,
    events: data.events.map(shape),
    modes: { day: true, week: true, month: true, year: false, agenda: true },
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
    async refresh() {
      const d = await get('/api/me/agenda');
      cal.resourceStore.data = d.missions;
      cal.eventStore.data = d.events.map(shape);
      empty.hidden = d.events.length > 0;
    },
  };
  return api;
}
