// Shopping real products with Channel3: one API, 100M+ products from 25,000+ retailers, with photos, brands,
// key features and each retailer's price, availability and buy link. Mandat searches, compares and
// recommends; the purchase is paid with PayPal. Key from CHANNEL3_API_KEY or the private secrets file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let key;
export function shopKey() {
  if (key !== undefined) return key;
  if (process.env.CHANNEL3_API_KEY) return (key = process.env.CHANNEL3_API_KEY.trim());
  try {
    const f = process.env.CHANNEL3_KEY_FILE || path.join(os.homedir(), 'Library/Application Support/StudioPilot/secrets/channel3.json');
    if (fs.statSync(f).mode & 0o077) throw new Error('channel3.json permissions are too open');
    key = JSON.parse(fs.readFileSync(f, 'utf8')).api_key?.trim() || null;
  } catch { key = null; }
  return key;
}
export const shopEnabled = () => !!shopKey();

// Guarded: searches per person and per day, a global daily cap, and a short cache.
const PER_USER = Number(process.env.MANDAT_SHOP_SEARCHES_PER_USER_DAY) || 40;
const GLOBAL = Number(process.env.MANDAT_SHOP_SEARCHES_PER_DAY) || 600;
let day = '', used = 0, perUser = new Map();
const cache = new Map();
// Europe is searched as a whole, priced in euros: the France-only catalogue is a handful of shops (no adult
// e-scooter at all), while retailers that ship across Europe carry the real ranges.
const MARKET = { fr: { currency: 'EUR' }, en: { country: 'US', language: 'en', currency: 'USD' } };

// The shape Mandat works with: one product, its best offer, a few facts. Cheapest in-stock offer first.
function shape(p) {
  const offers = (p.offers || []).filter((o) => o?.url && o.price?.price > 0).sort((a, b) => (a.availability === 'InStock' ? 0 : 1) - (b.availability === 'InStock' ? 0 : 1) || a.price.price - b.price.price);
  const best = offers[0];
  if (!best) return null;
  const img = (p.images || []).find((i) => i.is_main_image) || p.images?.[0];
  return {
    id: p.id,
    title: String(p.title || '').slice(0, 140),
    brand: p.brands?.[0]?.name || '',
    image: img?.cleaned_url || img?.url || '',
    photo: img?.url || '',
    price: best.price.price,
    was: best.price.compare_at_price || null,
    currency: best.price.currency,
    retailer: best.domain,
    url: best.url,
    inStock: best.availability === 'InStock',
    offers: offers.slice(0, 3).map((o) => ({ retailer: o.domain, price: o.price.price, currency: o.price.currency, inStock: o.availability === 'InStock', url: o.url })),
    features: (p.key_features || []).slice(0, 4).map((x) => String(x).slice(0, 90)),
    category: p.category?.title || '',
    description: String(p.description || '').slice(0, 300),
  };
}

export async function searchProducts({ query, minPrice, maxPrice, limit = 8, lang = 'en', userId = '' }) {
  const k = shopKey();
  if (!k) throw Object.assign(new Error('shop_off'), { status: 503 });
  const q = String(query || '').trim().slice(0, 200);
  if (!q) throw new Error('Say what to look for.');
  const ck = JSON.stringify([q, minPrice, maxPrice, limit, lang]).toLowerCase();
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < 3 * 3600e3) return hit.data;
  const today = new Date().toISOString().slice(0, 10);
  if (day !== today) { day = today; used = 0; perUser = new Map(); }
  const mine = perUser.get(userId) || 0;
  if (used >= GLOBAL || mine >= PER_USER) throw Object.assign(new Error('shop_cap'), { status: 429 });
  const price = {};
  if (minPrice > 0) price.min_price = minPrice;
  if (maxPrice > 0) price.max_price = maxPrice;
  const body = { query: q, limit: Math.min(12, Math.max(3, limit)), filters: { availability: ['InStock'], ...(Object.keys(price).length ? { price } : {}) }, config: MARKET[lang] || MARKET.en };
  const r = await fetch('https://api.trychannel3.com/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': k, ...(userId ? { 'x-user-id': userId } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Object.assign(new Error('Channel3 HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160)), { status: r.status });
  used++;
  perUser.set(userId, mine + 1);
  const data = ((await r.json()).products || []).map(shape).filter(Boolean);
  cache.set(ck, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}
