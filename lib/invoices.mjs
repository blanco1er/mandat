// Split the bill with real PayPal invoices, through the official PayPal Agent Toolkit (@paypal/agent-toolkit).
// Each friend gets their own invoice: PayPal emails it when we know their address, and every invoice also
// has a pay link and a QR code, so someone at the same table (or on the same trip) can pay in seconds —
// with or without the Mandat app. The invoice note invites them to try Mandat.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import * as PayPal from './paypal.mjs';

const require = createRequire(import.meta.url);
let toolkit = null;
function kit() {
  if (toolkit) return toolkit;
  const keys = PayPal.credentials();
  if (!keys) return null;
  const { PayPalAgentToolkit } = require('@paypal/agent-toolkit/openai');
  toolkit = new PayPalAgentToolkit({
    ...keys,
    configuration: { actions: { invoices: { create: true, send: true, generateQRC: true, get: true } }, context: { sandbox: true } },
  });
  return toolkit;
}

// Run one toolkit tool exactly as an agent framework would (OpenAI tool-call shape).
async function tool(name, args) {
  const r = await kit().handleToolCall({ id: 'call_' + crypto.randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const text = String(r.content ?? '');
  try { return JSON.parse(text); } catch { return text; }
}

const money = (v) => (Math.round(v * 100) / 100).toFixed(2);

// One friend's share → a sent invoice with a pay link and a QR code.
export async function shareInvoice({ friend, email, amount, currency, label, from, appUrl }) {
  const note = `${from ? from + ' paid' : 'Paid'} for "${label}" with Mandat and split it with you. Pay your share here.\n\nMandat is an AI agent that books and pays inside a budget you set — try it: ${appUrl}`;
  if (!kit()) {
    // Offline demo: same shape, clearly flagged, no money and no email.
    const id = 'OFFLINE-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    return { invoiceId: id, payUrl: `${appUrl}/?offline=1`, qr: null, emailed: false, status: 'SENT', mode: 'offline' };
  }
  const [given, ...rest] = String(friend).trim().split(/\s+/);
  const created = await tool('create_invoice', {
    currency_code: currency,
    note,
    reference: 'Mandat split',
    primary_recipients: [{ billing_info: { name: { given_name: given || 'Friend', ...(rest.length ? { surname: rest.join(' ') } : {}) }, ...(email ? { email_address: email } : {}) } }],
    items: [{ name: `Your share: ${label}`.slice(0, 200), quantity: '1', unit_amount: { currency_code: currency, value: money(amount) } }],
  });
  const invoiceId = (created?.href || JSON.stringify(created)).match(/INV2-[A-Z0-9-]+/)?.[0];
  if (!invoiceId) throw new Error('PayPal did not create the invoice: ' + JSON.stringify(created).slice(0, 200));
  // Sending makes it payable; PayPal emails it only when the friend has an email address.
  const sent = await tool('send_invoice', { invoice_id: invoiceId, send_to_recipient: !!email });
  const payUrl = sent?.href || `https://www.sandbox.paypal.com/invoice/p/#${invoiceId}`;
  const qr = await tool('generate_invoice_qr_code', { invoice_id: invoiceId, width: 360, height: 360 }).then(qrDataUrl).catch(() => null);
  return { invoiceId, payUrl, qr, emailed: !!email, status: 'SENT', mode: 'sandbox' };
}

// The toolkit returns the QR image as a multipart body; keep only the PNG, as a data URL.
function qrDataUrl(body) {
  const b64 = String(body).match(/\r?\n\r?\n([A-Za-z0-9+/=\r\n]{200,})\r?\n--/)?.[1]?.replace(/\s+/g, '');
  return b64 ? 'data:image/png;base64,' + b64 : null;
}

// Current status of an invoice (SENT, PAID, PARTIALLY_PAID, CANCELLED…).
export async function invoiceStatus(invoiceId) {
  if (!kit() || invoiceId.startsWith('OFFLINE-')) return null;
  const inv = await tool('get_invoice', { invoice_id: invoiceId });
  return inv?.status || null;
}
