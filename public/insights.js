// Activity tab: the spending dashboard, built with AG Studio.
//
// Two tables come from the server (/api/me/insights): every payment Mandat made, held, released or refunded,
// and every mission with its budget, what is committed at full price and what is really left. The page opens
// on a ready-made report, and the Studio Agent Framework lets the user change it in words ("show what I spent
// per week", "only the wedding"). Studio's own five agents run on Mandat's model through a small adapter: the
// request goes to our server (/api/studio/llm), so no key ever reaches the browser. The lead agent gets one
// tool of ours, mission_books, which returns the books exactly as the app computes them.
const STUDIO = 'https://cdn.jsdelivr.net/npm/ag-studio@3.0.0/dist/umd/ag-studio.min.js';

const WORDS = {
  en: {
    paid: 'Paid', held: 'Held now', due: 'Still to pay', left: 'Budget left', byCat: 'Where the money goes', byMission: 'Budget per mission',
    payments: 'Every payment', date: 'Date', merchant: 'Merchant or friend', category: 'Category', what: 'What', kind: 'Type', status: 'Status',
    spent: 'Paid', heldF: 'Held', refunded: 'Refunded', full: 'Full price', balance: 'Balance due', owed: 'Owed to you', back: 'Paid back', ref: 'PayPal reference',
    mission: 'Mission', created: 'Created', city: 'City', budget: 'Budget', committed: 'Committed', leftF: 'Left', stillToPay: 'Still to pay', missionsT: 'Missions', paymentsT: 'Payments',
    page: 'Spending', placeholder: 'Ask for a chart, a filter, an answer…', send: 'Send', hello: 'Ask me about your spending: I can answer, or change the dashboard for you.', failed: 'That did not work. Try again in a moment.', seeBoard: 'See it on the dashboard',
    steps: { view_schema: 'Reading your data', view_report: 'Looking at the dashboard', view_page: 'Looking at the dashboard', mission_books: 'Checking your books', delegate_to: 'Working on the dashboard', add_widget: 'Adding a chart', configure_widget: 'Setting up the chart', execute_query: 'Running the numbers', position_widget: 'Placing the chart', remove_widget: 'Removing a chart', add_page_filter: 'Filtering the page', remove_page_filter: 'Removing a filter', other: 'Working' },
    starters: [
      ['Spending by week', 'Add a column chart of what I paid per week.'],
      ['Biggest payments', 'Which five payments were the largest, and for which mission?'],
      ['What is left to pay?', 'For each mission, what is still to pay, to whom and when?'],
    ],
    brief: 'This dashboard shows the user\'s own money, handled by Mandat, the agent that books and pays for them with PayPal. Table "payments": one row per deposit or purchase (status Held = reserved, not charged; Paid = captured; Released = never charged; Refunded) and per bill share sent to a friend. Table "missions": each errand with its budget, what is committed at full price, what is left and what is still to pay on site. Amounts are in euros. Answer in English, in a sentence or two, like a careful accountant. For any question about why an amount is what it is, or what is still owed to whom, call mission_books: its numbers are computed by the app, use them as they are and never add them up yourself. Never show internal ids (mission_id, payment_id) to the user: name missions by their title.',
  },
  fr: {
    paid: 'Payé', held: 'Bloqué', due: 'Reste à régler', left: 'Budget restant', byCat: 'Où va l’argent', byMission: 'Budget par mission',
    payments: 'Tous les paiements', date: 'Date', merchant: 'Commerçant ou proche', category: 'Catégorie', what: 'Objet', kind: 'Type', status: 'État',
    spent: 'Payé', heldF: 'Bloqué', refunded: 'Remboursé', full: 'Prix total', balance: 'Solde dû', owed: 'On vous doit', back: 'Remboursé par un proche', ref: 'Référence PayPal',
    mission: 'Mission', created: 'Créée le', city: 'Ville', budget: 'Budget', committed: 'Engagé', leftF: 'Restant', stillToPay: 'Reste à régler', missionsT: 'Missions', paymentsT: 'Paiements',
    page: 'Dépenses', placeholder: 'Demandez un graphique, un filtre, une réponse…', send: 'Envoyer', hello: 'Posez-moi une question sur vos dépenses : je réponds, ou je modifie le tableau pour vous.', failed: 'Ça n’a pas marché. Réessayez dans un instant.', seeBoard: 'Voir sur le tableau',
    steps: { view_schema: 'Je lis vos données', view_report: 'Je regarde le tableau', view_page: 'Je regarde le tableau', mission_books: 'Je consulte vos comptes', delegate_to: 'Je prépare le tableau', add_widget: 'J’ajoute un graphique', configure_widget: 'Je règle le graphique', execute_query: 'Je fais les calculs', position_widget: 'Je place le graphique', remove_widget: 'Je retire un graphique', add_page_filter: 'Je filtre la page', remove_page_filter: 'Je retire un filtre', other: 'Je travaille' },
    starters: [
      ['Dépenses par semaine', 'Ajoute un graphique en colonnes de ce que j’ai payé par semaine.'],
      ['Plus gros paiements', 'Quels sont les cinq plus gros paiements, et pour quelle mission ?'],
      ['Ce qu’il reste à régler', 'Pour chaque mission, qu’est-ce qu’il reste à régler, à qui et quand ?'],
    ],
    brief: 'Ce tableau de bord montre l’argent de l’utilisateur, géré par Mandat, l’agent qui réserve et paie pour lui avec PayPal. Table « payments » : une ligne par acompte ou achat (statut Held = bloqué, pas encaissé ; Paid = encaissé ; Released = jamais débité ; Refunded = remboursé) et par part de facture envoyée à un proche. Table « missions » : chaque démarche avec son budget, ce qui est engagé au prix total, ce qui reste et ce qui reste à régler sur place. Montants en euros. Réponds en français, vouvoiement, en une ou deux phrases, comme un comptable rigoureux. Pour toute question sur la raison d’un montant ou sur ce qui reste dû et à qui, appelle mission_books : ses chiffres sont calculés par l’appli, reprends-les tels quels et ne fais jamais l’addition toi-même. N’affiche jamais d’identifiant interne (mission_id, payment_id) : nomme les missions par leur titre.',
  },
};

let loading;
function loadStudio() {
  return (loading ||= new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = STUDIO;
    s.onload = () => (window.agStudio ? ok(window.agStudio) : ko(new Error('AG Studio missing')));
    s.onerror = () => { loading = null; ko(new Error('AG Studio unavailable')); };
    document.head.append(s);
  }));
}

// Studio's AgLlmAdapter: one turn = one POST to our server, which calls the model and answers with Studio
// output items. They are replayed as AG-UI events (text, then each tool call); Studio runs the tools itself.
function mandatAdapter(post) {
  return {
    executeTurn(request, options = {}) {
      const done = post('/api/studio/llm', request, { signal: options.signal }).then(
        (r) => ({ id: 'turn_' + Date.now().toString(36), createdAt: Date.now(), status: 'completed', output: r.output || [], usage: r.usage, model: r.model }),
        (e) => ({ id: 'turn_' + Date.now().toString(36), createdAt: Date.now(), status: e.name === 'AbortError' ? 'cancelled' : 'failed', output: [], error: { code: 'model_error', message: e.message || 'The model did not answer.' } }),
      );
      return {
        complete: done,
        stream: {
          async *[Symbol.asyncIterator]() {
            const r = await done;
            for (const item of r.output) {
              if (item.type === 'message') {
                const text = item.content.map((c) => c.text || '').join('');
                yield { type: 'TEXT_MESSAGE_START', messageId: item.id, role: 'assistant' };
                yield { type: 'TEXT_MESSAGE_CONTENT', messageId: item.id, delta: text };
                yield { type: 'TEXT_MESSAGE_END', messageId: item.id };
              } else if (item.type === 'function_call') {
                yield { type: 'TOOL_CALL_START', toolCallId: item.callId, toolCallName: item.name };
                yield { type: 'TOOL_CALL_ARGS', toolCallId: item.callId, delta: item.arguments };
                yield { type: 'TOOL_CALL_END', toolCallId: item.callId };
              }
            }
          },
        },
      };
    },
  };
}

function sources(data, W) {
  const money = { format: 'currencyFormat', formatOptions: { format: '#,##0.00 €' } };
  return {
    sources: [
      {
        id: 'payments', name: W.paymentsT,
        data: data.payments.map((p) => ({ ...p, date: p.date ? new Date(p.date) : null })),
        fields: [
          { id: 'payment_id', name: 'ID', format: 'textFormat', cardinality: 'high' },
          { id: 'mission_id', name: 'Mission ID', format: 'textFormat' },
          { id: 'date', name: W.date, format: 'dateTimeFormat' },
          { id: 'merchant', name: W.merchant, format: 'textFormat' },
          { id: 'category', name: W.category, format: 'textFormat' },
          { id: 'what', name: W.what, format: 'textFormat', cardinality: 'high' },
          { id: 'kind', name: W.kind, format: 'textFormat' },
          { id: 'status', name: W.status, format: 'textFormat' },
          { id: 'spent', name: W.spent, ...money },
          { id: 'held', name: W.heldF, ...money },
          { id: 'refunded', name: W.refunded, ...money },
          { id: 'full_price', name: W.full, ...money },
          { id: 'balance_due', name: W.balance, ...money },
          { id: 'owed_to_you', name: W.owed, ...money },
          { id: 'paid_back', name: W.back, ...money },
          { id: 'paypal_ref', name: W.ref, format: 'textFormat', cardinality: 'high' },
        ],
      },
      {
        id: 'missions', name: W.missionsT,
        data: data.missions.map((m) => ({ ...m, created: m.created ? new Date(m.created) : null })),
        fields: [
          { id: 'mission_id', name: 'Mission ID', format: 'textFormat', cardinality: 'high' },
          { id: 'mission', name: W.mission, format: 'textFormat' },
          { id: 'created', name: W.created, format: 'dateTimeFormat' },
          { id: 'city', name: W.city, format: 'textFormat' },
          { id: 'budget', name: W.budget, ...money },
          { id: 'committed', name: W.committed, ...money },
          { id: 'left', name: W.leftF, ...money },
          { id: 'paid', name: W.spent, ...money },
          { id: 'held', name: W.heldF, ...money },
          { id: 'still_to_pay', name: W.stillToPay, ...money },
        ],
      },
    ],
    relationships: [
      { id: 'payment-mission', source: { tableId: 'payments', fieldId: 'mission_id' }, target: { tableId: 'missions', fieldId: 'mission_id' }, type: 'many-to-one' },
    ],
  };
}

// The report the page opens on. On a phone every widget takes the full width, one under the other.
function report(W, narrow) {
  const sum = (id) => ({ id, aggregation: 'sum' });
  const widgets = {
    'by-category': {
      type: 'donut-chart',
      dataMapping: { categoryKey: [{ id: 'payments.category' }], valueKey: [sum('payments.spent')], tooltipKey: [] },
      format: { title: { enabled: true, text: W.byCat } },
    },
    'by-mission': {
      type: 'bar-chart-grouped',
      dataMapping: { categoryKey: [{ id: 'missions.mission' }], valueKey: [sum('missions.committed'), sum('missions.left')], tooltipKey: [] },
      sort: [{ field: sum('missions.committed'), direction: 'desc' }],
      format: { title: { enabled: true, text: W.byMission } },
    },
    payments: {
      type: 'grid',
      dataMapping: {
        cols: [{ id: 'payments.date' }, { id: 'payments.merchant' }, { id: 'missions.mission' }, { id: 'payments.status' }, { id: 'payments.spent' }, { id: 'payments.held' }, { id: 'payments.balance_due' }, { id: 'payments.paypal_ref' }],
      },
      sort: [{ field: { id: 'payments.date' }, direction: 'desc' }],
      format: { title: { enabled: true, text: W.payments } },
    },
  };
  const wide = { 'by-category': [0, 0, 10, 14], 'by-mission': [10, 0, 14, 14], payments: [0, 14, 24, 16] };
  const phone = { 'by-category': [0, 0, 24, 13], 'by-mission': [0, 13, 24, 13], payments: [0, 26, 24, 18] };
  const pos = narrow ? phone : wide;
  return {
    pages: [{
      id: 'spending', name: W.page, widgets,
      ...(narrow ? { layout: { minWidth: 300 } } : {}),
      widgetLayout: Object.fromEntries(Object.entries(pos).map(([k, [x, y, w, h]]) => [k, { xTrack: x, yTrack: y, xSpan: w, ySpan: h }])),
    }],
    selectedPageId: 'spending',
    panels: { filters: { collapsed: true }, data: { collapsed: true }, edit: { collapsed: true }, ai: { collapsed: true } },
  };
}

// Mandat's materials: the same paper, ink and blue as the rest of the app, in light and dark.
function theme(ag) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return ag.studioTheme.withParams({
    browserColorScheme: dark ? 'dark' : 'light',
    fontFamily: '-apple-system, "SF Pro Text", system-ui, sans-serif',
    accentColor: '#0a6cff',
    backgroundColor: dark ? '#141519' : '#ffffff',
    foregroundColor: dark ? '#f5f5f7' : '#111216',
    borderColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(17,18,22,0.08)',
    borderRadius: 10,
    studioWrapperBackgroundColor: dark ? '#0b0c10' : '#f4f1ec',
    studioWrapperBorderRadius: 18,
    studioMinWidth: 320,
    chartPaletteFills1Color: '#0a6cff', chartPaletteFills2Color: '#f2a33a', chartPaletteFills3Color: '#19a463',
    chartPaletteFills4Color: '#8f5cf7', chartPaletteFills5Color: '#e5484d', chartPaletteFills6Color: '#00a3b4',
  });
}

export async function mountInsights(el, { get, post, lang, license, compact = false }) {
  const W = WORDS[lang] || WORDS.en;
  let [ag, data, fr] = await Promise.all([
    loadStudio(),
    get('/api/me/insights'),
    lang === 'fr' ? fetch('/ag-studio-fr.json').then((r) => r.json()).catch(() => null) : null,
  ]);
  if (license) ag.AgStudioLicenseManager.setLicenseKey(license);
  const narrow = compact || innerWidth < 720;
  const adapter = mandatAdapter(post);
  let harness = null;
  // The agents: Studio's five on Mandat's model, the lead with a Mandat brief and the books tool. Built from
  // the API as soon as the dashboard exists (Studio only builds the `ai` harness when its own panel shows,
  // and here the conversation is Mandat's own UI).
  const buildHarness = (api) => {
    // The books, exactly as the app computes them (never added up by the model).
    const books = api.defineAiTool({
      name: 'mission_books',
      description: 'The books of the user\'s missions, computed by Mandat: for each booking its full price, what was paid or held, the balance and when, what was cancelled or refunded, and the totals. Use it to explain an amount or to say what is still owed to whom.',
      params: (s) => s.object({ mission_id: s.string({ description: 'One mission (missions.mission_id). Omit for every mission.' }).optional() }),
      execute: async (args, ctx) => {
        const r = await get('/api/me/books' + (args.mission_id ? '?mission=' + encodeURIComponent(args.mission_id) : ''));
        return r.missions.length ? ctx.success(r.missions.map((m) => `${m.mission} (${m.mission_id})\n${m.books}`).join('\n\n')) : ctx.error('No mission with that id.');
      },
    });
    harness = ag.createAiHarness(api, ({ builtIn }) => ({
      agents: Object.values(builtIn).map((def) => ag.directLlmRunner({
        ...def,
        adapter,
        instructions: (c, p) => `${W.brief}\n\n${def.instructions ? def.instructions(c, p) : ''}`,
        ...(def.id === 'lead' ? { tools: (c, p) => [...(def.tools ? def.tools(c, p) : []), books] } : {}),
      })),
      primary: 'lead',
      promptStarters: W.starters.map(([label, prompt]) => ({ label, prompt })),
    }));
    return harness;
  };
  const api = ag.createStudioWithAi(el, {
    // A phone shows the report and the assistant; building by hand (compose, data) is for larger screens.
    mode: narrow ? 'view' : 'edit',
    // The conversation is shown by Mandat's own assistant (mountAssistant below), not by Studio's panel.
    panels: narrow ? { view: { left: [], right: [] } } : { edit: { left: [], right: ['filters', 'edit', 'data'] }, view: { left: [], right: ['filters'] } },
    theme: theme(ag),
    data: sources(data, W),
    initialState: report(W, narrow),
    localeText: { ...(fr || {}), aiMessageInputPlaceholder: W.placeholder },
    ai: ({ api }) => harness || buildHarness(api),
  });
  if (!harness) buildHarness(api);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => api.setProperty('theme', theme(ag)));
  return {
    api,
    harness: () => harness,
    // New payments land in the same report without resetting what the user built.
    async refresh() { data = await get('/api/me/insights'); api.setProperty('data', sources(data, W)); },
    csv() {
      const cols = ['date', 'mission_id', 'merchant', 'category', 'what', 'kind', 'status', 'spent', 'held', 'refunded', 'balance_due', 'paypal_ref'];
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      return [cols.join(','), ...data.payments.map((p) => cols.map((c) => q(p[c])).join(','))].join('\n');
    },
  };
}

// Mandat's own assistant on top of the Studio Agent Framework: the same harness and agents as Studio's panel,
// read through its session (messages, status) and drawn in the app's style: your words in a blue bubble,
// the answer in plain text, each step of the agents in a few words with a spinner, then a check.
const HIDDEN_STEPS = new Set(['rename_thread', 'update_plan', 'clear_plan', 'view_plan', 'complete_task']);
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function md(text) {
  const lines = escHtml(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split('\n');
  let out = '', list = false;
  for (const l of lines) {
    const item = l.match(/^\s*(?:[-•*]|\d+[.)])\s+(.*)/);
    if (item) { if (!list) { out += '<ul>'; list = true; } out += `<li>${item[1]}</li>`; continue; }
    if (list) { out += '</ul>'; list = false; }
    if (l.trim()) out += `<p>${l}</p>`;
  }
  return out + (list ? '</ul>' : '');
}
export function mountAssistant(el, studio, { lang, onBoardChange } = {}) {
  const W = WORDS[lang] || WORDS.en;
  el.classList.add('sc');
  el.innerHTML = `<div class="sc-log" role="log" aria-live="polite"><p class="sc-hello">${escHtml(W.hello)}</p></div>
    <div class="sc-starters">${W.starters.map(([label, prompt]) => `<button type="button" data-p="${escHtml(prompt)}">${escHtml(label)}</button>`).join('')}</div>
    <form class="sc-bar" autocomplete="off"><input aria-label="${escHtml(W.placeholder)}" placeholder="${escHtml(W.placeholder)}" enterkeyhint="send"><button type="submit" class="sc-send" aria-label="${escHtml(W.send)}"><svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button></form>`;
  const log = el.querySelector('.sc-log'), input = el.querySelector('input'), form = el.querySelector('form');
  let session = null, changedBoard = false;
  const step = (call) => {
    if (HIDDEN_STEPS.has(call.name)) return '';
    const done = call.status === 'complete', bad = call.status === 'error' || call.status === 'cancelled';
    if (['add_widget', 'configure_widget', 'position_widget', 'remove_widget', 'add_page_filter', 'remove_page_filter'].includes(call.name) || (call.name === 'delegate_to' && done)) changedBoard = true;
    return `<div class="sc-step ${done ? 'done' : bad ? 'bad' : 'run'}"><i aria-hidden="true"></i>${escHtml(W.steps[call.name] || W.steps.other)}</div>`;
  };
  function render() {
    const busy = session.status === 'running';
    let html = '';
    for (const m of session.messages) {
      if (m.role === 'user') { html += `<div class="sc-me">${escHtml(m.parts.map((p) => p.text || '').join(''))}</div>`; continue; }
      if (m.role !== 'assistant') continue;
      for (const p of m.parts) {
        if (p.type === 'text' && p.text.trim()) html += `<div class="sc-say">${md(p.text)}</div>`;
        else if (p.type === 'tool_call') html += step(p.toolCall);
        else if (p.type === 'error') html += `<div class="sc-err">${escHtml(W.failed)}</div>`;
      }
    }
    if (busy) html += '<div class="sc-typing" aria-hidden="true"><i></i><i></i><i></i></div>';
    else if (changedBoard && onBoardChange) html += `<button type="button" class="sc-board">${escHtml(W.seeBoard)}</button>`;
    if (session.status === 'error') html += `<div class="sc-err">${escHtml(W.failed)}</div>`;
    log.innerHTML = html;
    log.querySelector('.sc-board')?.addEventListener('click', () => onBoardChange());
    form.querySelector('button').disabled = busy;
    log.scrollTop = log.scrollHeight;
  }
  async function send(text) {
    text = String(text || '').trim();
    if (!text || session?.status === 'running') return;
    const harness = studio.harness();
    if (!harness) { console.warn('[assistant] no harness yet'); return; }
    el.querySelector('.sc-starters').hidden = true;
    changedBoard = false;
    if (!session) {
      try { session = await harness.createThread({ agentId: 'lead' }); } catch (e) { console.warn('[assistant] createThread', e); return; }
      session.addEventListener('changed', render);
    }
    session.sendMessage(text);
    render();
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value; input.value = ''; send(v); });
  el.querySelectorAll('.sc-starters button').forEach((b) => b.addEventListener('click', () => send(b.dataset.p)));
  return { focus: () => input.focus() };
}
