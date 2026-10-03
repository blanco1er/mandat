// One payment's receipt, as a clean printable page (save it as a PDF from the browser's print sheet).
// Only the owner can open it: the payment is looked up in their own missions.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const W = {
  en: {
    title: 'Payment receipt', no: 'Receipt no.', date: 'Date', merchant: 'Paid to', mission: 'Mission', what: 'For', payer: 'Paid by',
    amount: 'Amount', state: 'Status', full: 'Full price of the booking', refunded: 'Refunded', net: 'Net paid', due: 'Balance still to pay to the merchant',
    refs: 'PayPal references', order: 'Order', auth: 'Authorization', capture: 'Capture', refund: 'Refund', invoice: 'Invoice',
    print: 'Save as PDF / Print', csv: 'Download CSV', sandbox: 'PayPal sandbox: a test payment, no real money moved.', by: 'Paid on your behalf by Mandat, inside the mandate you signed with PayPal.',
    st: { held: 'Held (reserved, not charged)', captured: 'Paid', released: 'Released (never charged)', refunded: 'Refunded', PAID: 'Paid back', other: 'Owed to you' },
  },
  fr: {
    title: 'Reçu de paiement', no: 'Reçu n°', date: 'Date', merchant: 'Payé à', mission: 'Mission', what: 'Pour', payer: 'Payé par',
    amount: 'Montant', state: 'État', full: 'Prix total de la réservation', refunded: 'Remboursé', net: 'Payé net', due: 'Solde restant à régler au prestataire',
    refs: 'Références PayPal', order: 'Commande', auth: 'Autorisation', capture: 'Encaissement', refund: 'Remboursement', invoice: 'Facture',
    print: 'Enregistrer en PDF / Imprimer', csv: 'Télécharger en CSV', sandbox: 'PayPal sandbox : paiement de test, aucun argent réel n’a circulé.', by: 'Payé pour vous par Mandat, dans le cadre du mandat signé avec PayPal.',
    st: { held: 'Bloqué (réservé, non débité)', captured: 'Payé', released: 'Libéré (jamais débité)', refunded: 'Remboursé', PAID: 'Reçu', other: 'À recevoir' },
  },
};

export function findPayment(u, getMission, id) {
  for (const mid of u.missions) {
    const s = getMission(mid);
    if (!s) continue;
    const e = s.envelope.entries.find((x) => x.id === id);
    if (e) return { s, e };
    const sh = (s.shares || []).find((x) => x.invoiceId === id);
    if (sh) return { s, share: sh };
  }
  return null;
}

export function receiptHtml({ s, e, share }, u, lang = 'en') {
  const L = W[lang === 'fr' ? 'fr' : 'en'];
  const loc = lang === 'fr' ? 'fr-FR' : 'en-GB';
  const cur = s.envelope.currency || 'EUR';
  const money = (v) => Number(v || 0).toLocaleString(loc, { style: 'currency', currency: cur });
  const at = new Date(e?.at || share?.at || s.createdAt);
  const rows = [];
  const refs = [];
  let id, title, amountRows;
  if (e) {
    id = e.id;
    const refunded = Number(e.refunded || 0);
    const full = Number(e.total) > e.amount ? Number(e.total) : e.amount;
    rows.push([L.merchant, e.merchant], [L.what, e.label], [L.mission, s.title || 'Mission']);
    amountRows = [[L.amount, money(e.amount)], ...(refunded ? [[L.refunded, '− ' + money(refunded)], [L.net, money(e.amount - refunded)]] : [])];
    if ((e.state === 'held' || e.state === 'captured') && full > e.amount + 0.5) amountRows.push([L.full, money(full)], [L.due, money(full - e.amount)]);
    title = L.st[e.state] || e.state;
    const p = e.paypal || {};
    if (p.orderId) refs.push([L.order, p.orderId]);
    if (p.authorizationId) refs.push([L.auth, p.authorizationId]);
    if (p.captureId) refs.push([L.capture, p.captureId]);
    if (p.refundId) refs.push([L.refund, p.refundId]);
  } else {
    id = share.invoiceId;
    rows.push([L.merchant, share.friend], [L.what, share.label || ''], [L.mission, s.title || 'Mission']);
    amountRows = [[L.amount, money(share.amount)]];
    title = share.status === 'PAID' ? L.st.PAID : L.st.other;
    refs.push([L.invoice, share.invoiceId]);
  }
  const payer = [u.paypal?.payerName, u.paypal?.payerEmail].filter(Boolean).join(' · ');
  if (payer) rows.push([L.payer, payer]);
  const table = (list) => list.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const csv = [['receipt', 'date', 'merchant', 'for', 'mission', 'amount', 'refunded', 'status', 'paypal_reference', 'currency'],
    [id, at.toISOString(), e?.merchant || share?.friend, e?.label || share?.label || '', s.title || '', e ? e.amount : share.amount, e?.refunded || 0, title, refs.map((r) => r[1]).join(' '), cur]]
    .map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  return `<!doctype html><html lang="${lang === 'fr' ? 'fr' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(L.title)} · ${esc(e?.merchant || share?.friend)}</title>
<style>
:root{--ink:#111216;--ink2:#6e6e73;--line:rgba(17,18,22,.1);--accent:#0a6cff;--ok:#19a463}
*{box-sizing:border-box}body{margin:0;background:#f4f1ec;color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif}
.page{max-width:620px;margin:24px auto;background:#fff;border-radius:18px;padding:32px 28px;box-shadow:0 12px 40px rgba(25,20,10,.08)}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:1px solid var(--line);padding-bottom:18px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px}.mark{width:30px;height:30px;border-radius:9px;background:#111216;position:relative}
.mark::after{content:"";position:absolute;width:12px;height:12px;border:3px solid #fff;border-radius:50%;left:6px;top:6px}.mark::before{content:"";position:absolute;width:6px;height:6px;border-radius:50%;background:#f2a33a;right:5px;bottom:5px}
h1{font-size:22px;margin:22px 0 2px}.sub{color:var(--ink2);font-size:13px}.no{text-align:right;font-size:12px;color:var(--ink2)}.no b{display:block;color:var(--ink);font-size:13px;word-break:break-all}
.state{display:inline-block;margin-top:10px;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:600;background:rgba(25,164,99,.12);color:#0f7a45}
table{width:100%;border-collapse:collapse;margin-top:18px}th,td{text-align:left;padding:9px 0;border-bottom:1px solid var(--line);vertical-align:top}th{width:42%;padding-right:14px;font-weight:500;color:var(--ink2)}td{font-weight:500;overflow-wrap:anywhere}
.amounts td{text-align:right;font-variant-numeric:tabular-nums}.amounts tr:last-child td,.amounts tr:last-child th{border-bottom:0}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink2);margin:24px 0 0}.refs td{font-family:ui-monospace,Menlo,monospace;font-size:13px;word-break:break-all}
.foot{margin-top:24px;font-size:12px;color:var(--ink2)}.actions{max-width:620px;margin:0 auto 32px;display:flex;gap:10px;padding:0 4px}
.actions button,.actions a{flex:1;text-align:center;padding:13px;border-radius:14px;border:0;font:600 15px/1 inherit;font-family:inherit;background:#111216;color:#fff;text-decoration:none;cursor:pointer}.actions a{background:#fff;color:var(--ink);border:1px solid var(--line)}
@media (max-width:520px){.page{margin:0;border-radius:0;padding:24px 18px}th{width:38%}}@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none}.actions{display:none}}
</style></head><body>
<main class="page">
  <div class="top"><div class="brand"><span class="mark"></span>Mandat</div><div class="no">${esc(L.no)}<b>${esc(id)}</b>${esc(at.toLocaleString(loc, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</div></div>
  <h1>${esc(L.title)}</h1><div class="sub">${esc(L.by)}</div><span class="state">${esc(title)}</span>
  <table>${table(rows)}</table>
  <table class="amounts">${table(amountRows)}</table>
  ${refs.length ? `<h2>${esc(L.refs)}</h2><table class="refs">${table(refs)}</table>` : ''}
  <p class="foot">${esc(L.sandbox)}</p>
</main>
<div class="actions"><button type="button" onclick="print()">${esc(L.print)}</button><a download="mandat-${esc(id)}.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent(csv)}">${esc(L.csv)}</a></div>
</body></html>`;
}
