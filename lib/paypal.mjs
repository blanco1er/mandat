// PayPal REST client (sandbox) for an agent that pays on the user's behalf, inside a mandate.
//
// The flow that makes a budget agent possible:
//  1. Mandate: the user saves PayPal once (Vault v3: setup token -> user approves -> payment token).
//  2. Hold:    the agent creates an order with intent AUTHORIZE, paid with the vaulted token (no user present).
//  3. Capture: when the merchant confirms the service, the agent captures the authorization.
//  4. Release: if the plan changes, the agent voids the authorization (money never left).
//  5. Refund:  after capture, partial or full refund through Payments v2.
//  6. Split:   each friend gets a PayPal order link for their share.
//
// Without PAYPAL_CLIENT_ID/SECRET the client runs in "offline" mode: same interface, fake ids, clearly flagged
// (mode: 'offline') so the UI never pretends money moved. Real sandbox calls are used as soon as keys exist.
import crypto from 'node:crypto';

const BASE = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const SECRET = process.env.PAYPAL_CLIENT_SECRET;
export const MODE = CLIENT_ID && SECRET ? 'sandbox' : 'offline';

let token = null;
let tokenExpires = 0;

async function accessToken() {
  if (token && Date.now() < tokenExpires - 60_000) return token;
  const res = await fetch(BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(CLIENT_ID + ':' + SECRET).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('PayPal auth failed: HTTP ' + res.status);
  const data = await res.json();
  token = data.access_token;
  tokenExpires = Date.now() + data.expires_in * 1000;
  return token;
}

async function api(method, path, body, { idempotencyKey } = {}) {
  const headers = { Authorization: 'Bearer ' + (await accessToken()), 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (idempotencyKey) headers['PayPal-Request-Id'] = idempotencyKey;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const issue = data.details?.[0]?.issue || data.name || 'ERROR';
    throw new Error(`PayPal ${method} ${path} -> ${res.status} ${issue}`);
  }
  return data;
}

const fakeId = (p) => p + '-' + crypto.randomBytes(6).toString('hex').toUpperCase();
const money = (amount, currency) => ({ currency_code: currency, value: Number(amount).toFixed(2) });

// --- 1. Mandate (Vault v3) -------------------------------------------------------------------------
// Returns { id, approveUrl } — the user opens approveUrl once and signs the mandate in PayPal.
export async function createMandateSetup({ returnUrl, cancelUrl, description }) {
  if (MODE === 'offline') return { id: fakeId('SETUP'), approveUrl: returnUrl + (returnUrl.includes('?') ? '&' : '?') + 'offline=1', mode: MODE };
  const data = await api('POST', '/v3/vault/setup-tokens', {
    payment_source: {
      paypal: {
        description,
        usage_pattern: 'IMMEDIATE',
        usage_type: 'MERCHANT',
        customer_type: 'CONSUMER',
        permit_multiple_payment_tokens: true,
        experience_context: { return_url: returnUrl, cancel_url: cancelUrl, brand_name: 'Mandat', shipping_preference: 'NO_SHIPPING' },
      },
    },
  }, { idempotencyKey: crypto.randomUUID() });
  return { id: data.id, approveUrl: data.links.find((l) => l.rel === 'approve')?.href, mode: MODE };
}

// After the user approved the setup token, exchange it for a reusable payment token (the mandate).
export async function activateMandate(setupTokenId) {
  if (MODE === 'offline') return { paymentTokenId: fakeId('PTOKEN'), mode: MODE };
  const data = await api('POST', '/v3/vault/payment-tokens', { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } }, { idempotencyKey: crypto.randomUUID() });
  return { paymentTokenId: data.id, payer: data.payment_source?.paypal?.email_address, mode: MODE };
}

// --- 2. Hold ---------------------------------------------------------------------------------------
// Authorize funds for a merchant with the vaulted mandate, no user interaction.
export async function hold({ paymentTokenId, amount, currency, merchant, description, reference }) {
  if (MODE === 'offline') return { orderId: fakeId('ORDER'), authorizationId: fakeId('AUTH'), status: 'AUTHORIZED', mode: MODE };
  const order = await api('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    payment_source: { paypal: { vault_id: paymentTokenId } },
    purchase_units: [{
      reference_id: reference,
      description: `${merchant} — ${description}`.slice(0, 127),
      soft_descriptor: merchant.slice(0, 22),
      amount: money(amount, currency),
    }],
  }, { idempotencyKey: crypto.randomUUID() });
  const auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) throw new Error('PayPal returned no authorization (status ' + order.status + ')');
  return { orderId: order.id, authorizationId: auth.id, status: auth.status, mode: MODE };
}

// --- 3. Capture / 4. Release / 5. Refund ----------------------------------------------------------
export async function capture({ authorizationId, amount, currency }) {
  if (MODE === 'offline') return { captureId: fakeId('CAPTURE'), status: 'COMPLETED', mode: MODE };
  const data = await api('POST', `/v2/payments/authorizations/${authorizationId}/capture`, amount ? { amount: money(amount, currency), final_capture: true } : {}, { idempotencyKey: crypto.randomUUID() });
  return { captureId: data.id, status: data.status, mode: MODE };
}

export async function release({ authorizationId }) {
  if (MODE === 'offline') return { status: 'VOIDED', mode: MODE };
  await api('POST', `/v2/payments/authorizations/${authorizationId}/void`, null, { idempotencyKey: crypto.randomUUID() });
  return { status: 'VOIDED', mode: MODE };
}

export async function refund({ captureId, amount, currency, note }) {
  if (MODE === 'offline') return { refundId: fakeId('REFUND'), status: 'COMPLETED', mode: MODE };
  const data = await api('POST', `/v2/payments/captures/${captureId}/refund`, { amount: money(amount, currency), note_to_payer: note?.slice(0, 255) }, { idempotencyKey: crypto.randomUUID() });
  return { refundId: data.id, status: data.status, mode: MODE };
}

// --- 6. Split --------------------------------------------------------------------------------------
// A pay-your-share order for a friend: returns the PayPal approval link to send them.
export async function shareLink({ amount, currency, label, friend, returnUrl, cancelUrl }) {
  if (MODE === 'offline') return { orderId: fakeId('SHARE'), payUrl: returnUrl + (returnUrl.includes('?') ? '&' : '?') + 'offline=1', mode: MODE };
  const order = await api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{ reference_id: 'share-' + friend, description: `${label} — ${friend}'s share`.slice(0, 127), amount: money(amount, currency) }],
    payment_source: { paypal: { experience_context: { return_url: returnUrl, cancel_url: cancelUrl, brand_name: 'Mandat', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } },
  }, { idempotencyKey: crypto.randomUUID() });
  return { orderId: order.id, payUrl: order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href, mode: MODE };
}

export async function captureShare(orderId) {
  if (MODE === 'offline') return { status: 'COMPLETED', mode: MODE };
  const data = await api('POST', `/v2/checkout/orders/${orderId}/capture`, {}, { idempotencyKey: crypto.randomUUID() });
  return { status: data.status, mode: MODE };
}
