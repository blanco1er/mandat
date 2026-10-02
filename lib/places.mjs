// Real-world discovery with OpenStreetMap: geocoding (Nominatim) and nearby places (Overpass).
// Free, no key. We respect the usage policies: identify ourselves, cache results, keep the rate low.
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mandat-hackathon-demo/0.1 (PayPal AI Hackathon; contact via GitHub blanco1er)';
// Disk cache: a search already made comes back instantly (and the demo never depends on a busy public server).
const CACHE_FILE = path.resolve(process.env.MANDAT_DATA || 'data', 'osm-cache.json');
const cache = new Map(Object.entries(readCache()));

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache() {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache)));
}

const CATEGORY_TAGS = {
  restaurant: '["amenity"="restaurant"]',
  bar: '["amenity"~"bar|pub"]',
  cafe: '["amenity"="cafe"]',
  bakery: '["shop"~"bakery|pastry|confectionery"]',
  florist: '["shop"="florist"]',
  hotel: '["tourism"~"hotel|guest_house"]',
  hairdresser: '["shop"~"hairdresser|beauty"]',
  cinema: '["amenity"="cinema"]',
};

export const CATEGORIES = Object.keys(CATEGORY_TAGS);

async function getJSON(url, init = {}) {
  const key = (init.body ? '' : url) + (init.body || '');
  if (cache.has(key)) return cache.get(key);
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(12000), headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`OSM HTTP ${res.status}`);
  const data = await res.json();
  cache.set(key, data);
  writeCache();
  return data;
}

// "Paris 11e" -> { lat, lon, label }
export async function geocode(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(query);
  const [hit] = await getJSON(url);
  if (!hit) throw new Error('Place not found: ' + query);
  return { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name };
}

// Address suggestions for the usual address (title = street, sub = postcode and city).
function addrParts(h) {
  const a = h.address || {};
  const street = [a.house_number, a.road || a.pedestrian || a.square].filter(Boolean).join(' ') || h.name || (h.display_name || '').split(',')[0];
  const city = [a.postcode, a.city || a.town || a.village || a.municipality].filter(Boolean).join(' ');
  return { title: street, sub: [city, a.country].filter(Boolean).join(', '), label: [street, city].filter(Boolean).join(', ') || h.display_name, lat: Number(h.lat), lon: Number(h.lon) };
}
export async function searchAddress(q, lang = 'en', country = '') {
  const url = (cc) => `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&accept-language=${lang}${cc ? '&countrycodes=' + cc : ''}&q=${encodeURIComponent(q)}`;
  let hits = country ? await getJSON(url(country)) : [];
  if (!hits.length) hits = await getJSON(url('')); // nothing at home: look everywhere
  return hits.map(addrParts);
}
export async function reverseAddress(lat, lon, lang = 'en') {
  const h = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=${lang}&lat=${lat}&lon=${lon}`);
  return addrParts(h);
}

// Nearby places of a category, closest first.
export async function nearby({ lat, lon, category, radius = 1200, limit = 8 }) {
  const tags = CATEGORY_TAGS[category];
  if (!tags) throw new Error('Unknown category ' + category);
  const q = `[out:json][timeout:20];(node${tags}(around:${radius},${lat},${lon});way${tags}(around:${radius},${lat},${lon}););out center tags 60;`;
  const data = await overpass(q);
  return data.elements
    .map((e) => {
      const t = e.tags || {};
      const plat = e.lat ?? e.center?.lat;
      const plon = e.lon ?? e.center?.lon;
      return {
        osmId: `${e.type}/${e.id}`,
        name: t.name,
        category,
        cuisine: t.cuisine,
        address: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || undefined,
        openingHours: t.opening_hours,
        phone: t.phone || t['contact:phone'],
        website: t.website || t['contact:website'],
        image: t.image,
        commons: t.wikimedia_commons,
        wikidata: t.wikidata || t['brand:wikidata'],
        lat: plat,
        lon: plon,
        distance: Math.round(haversine(lat, lon, plat, plon)),
      };
    })
    .filter((p) => p.name && p.lat)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

// Public Overpass servers are often busy: try mirrors in turn, with one retry round.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function overpass(q) {
  const init = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) };
  let last;
  for (let round = 0; round < 2; round++) {
    for (const url of OVERPASS) {
      try {
        return await getJSON(url, init);
      } catch (e) {
        last = e;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw last;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- a visual preview of a real place, from free, open sources ----------
// Google Maps photos need a billed Google Cloud key (and may not be scraped), so the preview uses
// the merchant's own website image, Wikimedia Commons and Wikidata, and links to Google Maps for the rest.
const PREVIEW_UA = { 'User-Agent': 'Mandat/1.0 (hackathon demo; place previews)' };
const filePath = (f) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(String(f).replace(/^File:/i, '').trim())}?width=900`;
// Websites come from OpenStreetMap (anyone can edit it): only public addresses are fetched, redirects checked one by one.
const PRIVATE = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|::1$|::$|f[cd]|fe[89ab]|::ffff:(10|127|192\.168|169\.254)\.)/i;
async function publicUrl(raw) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error('blocked url');
  const { lookup } = await import('node:dns/promises');
  const addrs = await lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => PRIVATE.test(a.address))) throw new Error('blocked address');
  return u.href;
}
async function getText(url, ms = 6000, max = 600000) {
  let target = await publicUrl(url);
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(target, { headers: { ...PREVIEW_UA, Accept: 'text/html,application/json' }, signal: AbortSignal.timeout(ms), redirect: 'manual' });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { target = await publicUrl(new URL(r.headers.get('location'), target).href); continue; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return (await r.text()).slice(0, max);
  }
  throw new Error('too many redirects');
}
async function websiteImage(site) {
  const url = /^https?:\/\//i.test(site) ? site : 'https://' + site;
  const html = await getText(url);
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  return m ? new URL(m[1].replace(/&amp;/g, '&'), url).href : null;
}
async function commonsImages(tag) {
  if (/^File:/i.test(tag)) return [filePath(tag)];
  if (!/^Category:/i.test(tag)) return [];
  const j = JSON.parse(await getText(`https://commons.wikimedia.org/w/api.php?action=query&list=categorymembers&cmtype=file&cmlimit=4&format=json&cmtitle=${encodeURIComponent(tag)}`));
  return (j.query?.categorymembers || []).map((m) => filePath(m.title));
}
async function wikidataImages(q) {
  const j = JSON.parse(await getText(`https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(q)}.json`));
  const claims = j.entities?.[q]?.claims || {};
  return (claims.P18 || []).slice(0, 3).map((c) => filePath(c.mainsnak?.datavalue?.value)).filter(Boolean);
}
// Find a real place by name near a point (Nominatim, with OSM extra tags).
export async function findPlace(name, near) {
  const view = near ? `&viewbox=${near.lon - 0.05},${near.lat + 0.05},${near.lon + 0.05},${near.lat - 0.05}&bounded=0` : '';
  const j = JSON.parse(await getText(`https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&addressdetails=1&limit=1&q=${encodeURIComponent(name)}${view}`));
  const h = j[0];
  if (!h) return null;
  const t = h.extratags || {};
  const lat = Number(h.lat), lon = Number(h.lon);
  return {
    name: h.name || name, category: h.type, address: [h.address?.house_number, h.address?.road, h.address?.city || h.address?.town].filter(Boolean).join(' '),
    openingHours: t.opening_hours, phone: t.phone || t['contact:phone'], website: t.website || t['contact:website'],
    image: t.image, commons: t.wikimedia_commons, wikidata: t.wikidata || t['brand:wikidata'],
    lat, lon, distance: near ? Math.round(haversine(near.lat, near.lon, lat, lon)) : undefined,
  };
}
// ---------- Google Places (New): real photos and ratings, under a strict daily cap ----------
import fs2 from 'node:fs';
import os2 from 'node:os';
import path2 from 'node:path';
let googleKey;
export function gKey() {
  if (googleKey !== undefined) return googleKey;
  if (process.env.GOOGLE_PLACES_KEY) return (googleKey = process.env.GOOGLE_PLACES_KEY);
  try {
    const f = process.env.GOOGLE_PLACES_KEY_FILE || path2.join(os2.homedir(), 'Library/Application Support/StudioPilot/secrets/google-places.json');
    if (fs2.statSync(f).mode & 0o077) throw new Error('google-places.json permissions are too open');
    googleKey = JSON.parse(fs2.readFileSync(f, 'utf8')).api_key?.trim() || null;
  } catch { googleKey = null; }
  return googleKey;
}
export const googleEnabled = () => !!gKey();
// Never leave the free tier: hard caps per day on searches and on photos.
const GCAP = Number(process.env.MANDAT_GOOGLE_PREVIEWS_PER_DAY || 30);
const PCAP = Number(process.env.MANDAT_GOOGLE_PHOTOS_PER_DAY || 90);
let pUse = { day: '', n: 0 };
function photoAllowed() {
  const day = new Date().toISOString().slice(0, 10);
  if (pUse.day !== day) pUse = { day, n: 0 };
  return pUse.n++ < PCAP;
}
const KIND_WORD = { hotel: 'hotel', restaurant: 'restaurant', bar: 'bar', cafe: 'café', bakery: 'bakery', florist: 'florist', cinema: 'cinema', hairdresser: 'hair salon', guest_house: 'hotel', hostel: 'hostel', museum: 'museum', attraction: 'attraction' };
const KIND_TYPES = { hotel: ['lodging', 'hotel', 'motel', 'hostel', 'bed_and_breakfast', 'guest_house', 'resort_hotel', 'inn'], hostel: ['lodging', 'hostel'], guest_house: ['lodging', 'guest_house', 'bed_and_breakfast'], restaurant: ['restaurant', 'food', 'meal_takeaway'], bar: ['bar', 'night_club', 'pub', 'wine_bar'], cafe: ['cafe', 'coffee_shop', 'bakery', 'food'], bakery: ['bakery', 'food', 'cafe'], florist: ['florist', 'store'] };
let gUse = { day: '', n: 0 };
const gCache = new Map(); // query -> { at, data }
// When Google refuses (quota spent, billing off, key restricted), stop asking for an hour:
// the free sources and the Google Maps frame take over at once instead of waiting on a timeout.
let gPausedUntil = 0;
async function googlePlace(p) {
  const key = gKey();
  if (!key || Date.now() < gPausedUntil) return null;
  const query = `${p.name} ${KIND_WORD[p.category] || ''} ${p.address || p.near || ''}`.replace(/\s+/g, ' ').trim();
  const ck = query.toLowerCase();
  const hit = gCache.get(ck);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.data;
  const day = new Date().toISOString().slice(0, 10);
  if (gUse.day !== day) gUse = { day, n: 0 };
  if (gUse.n >= GCAP) return null;
  gUse.n++;
  const body = { textQuery: query, pageSize: 1, ...(p.lat ? { locationBias: { circle: { center: { latitude: p.lat, longitude: p.lon }, radius: 500 } } } : {}) };
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.googleMapsUri,places.photos,places.types' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) {
    if ([401, 403, 429].includes(r.status) || r.status >= 500) gPausedUntil = Date.now() + (r.status >= 500 ? 5 : 60) * 60000;
    throw new Error('Google Places HTTP ' + r.status + ' — using free sources' + (gPausedUntil > Date.now() ? ' for a while' : ''));
  }
  const g = (await r.json()).places?.[0];
  if (!g) return null;
  // A hotel must come back as lodging, a restaurant as food: never a namesake of another kind.
  const want = KIND_TYPES[p.category];
  if (want && !(g.types || []).some((t) => want.includes(t))) { gCache.set(ck, { at: Date.now(), data: null }); return null; }
  // Photo URLs are fetched server-side (the key never reaches the browser) and are short-lived Google links.
  const photos = await Promise.all((g.photos || []).slice(0, 3).map(async (ph) => {
    if (!photoAllowed()) return null;
    const m = await fetch(`https://places.googleapis.com/v1/${ph.name}/media?maxWidthPx=900&skipHttpRedirect=true`, { headers: { 'X-Goog-Api-Key': key }, signal: AbortSignal.timeout(6000) }).then((x) => x.json()).catch(() => null);
    const by = ph.authorAttributions?.[0]?.displayName;
    return m?.photoUri ? { url: m.photoUri, source: by ? `${by} on Google Maps` : 'Google Maps' } : null;
  }));
  const data = { name: g.displayName?.text, address: g.formattedAddress, lat: g.location?.latitude, lon: g.location?.longitude, rating: g.rating, ratings: g.userRatingCount, googleMaps: g.googleMapsUri, photos: photos.filter(Boolean) };
  gCache.set(ck, { at: Date.now(), data });
  return data;
}

// The best places of a city, for real: Google's ratings, number of reviews and price level, ranked for
// what the user asked (value for money, best rated, luxury). One photo each, to keep the free tier.
const TOP_TYPE = { hotel: 'lodging', restaurant: 'restaurant', bar: 'bar', cafe: 'cafe', museum: 'museum', attraction: 'tourist_attraction' };
const PRICE = { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };
export async function topPlaces({ category = 'hotel', city, sort = 'value', count = 5, lang = 'en' }) {
  const key = gKey();
  if (!key || Date.now() < gPausedUntil) return null;
  const day = new Date().toISOString().slice(0, 10);
  if (gUse.day !== day) gUse = { day, n: 0 };
  const ck = `top|${category}|${city}|${sort}|${lang}`.toLowerCase();
  const hit = gCache.get(ck);
  if (hit && Date.now() - hit.at < 12 * 3600e3) return hit.data;
  if (gUse.n >= GCAP) return null;
  gUse.n++;
  const word = { value: 'best value', rating: 'best rated', luxury: 'luxury' }[sort] || 'best';
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.googleMapsUri,places.websiteUri,places.photos,places.types' },
    body: JSON.stringify({ textQuery: `${word} ${KIND_WORD[category] || category}s in ${city}`, pageSize: 20, languageCode: lang, ...(TOP_TYPE[category] ? { includedType: TOP_TYPE[category] } : {}) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    if ([401, 403, 429].includes(r.status) || r.status >= 500) gPausedUntil = Date.now() + (r.status >= 500 ? 5 : 60) * 60000;
    throw new Error('Google Places HTTP ' + r.status);
  }
  let list = ((await r.json()).places || []).filter((g) => g.rating && (g.userRatingCount || 0) >= 50)
    .filter((g) => category !== 'hotel' || !((g.types || []).includes('hostel') || /hostel|auberge de jeunesse/i.test(g.displayName?.text || ''))); // a hotel search is not a hostel search
  const price = (g) => PRICE[g.priceLevel] ?? 2;
  const trust = (g) => g.rating - 1.5 / Math.sqrt(g.userRatingCount || 1); // a 4.8 from 12 reviews is not a 4.8 from 2,000
  if (sort === 'luxury') list = list.filter((g) => price(g) >= 3 || /luxury|palace|5 star/i.test(g.displayName?.text || '')).sort((a, b) => trust(b) - trust(a));
  else if (sort === 'value') list = list.sort((a, b) => (trust(b) - 0.25 * price(b)) - (trust(a) - 0.25 * price(a)));
  else list = list.sort((a, b) => trust(b) - trust(a));
  list = list.slice(0, Math.min(6, Math.max(1, count)));
  const out = await Promise.all(list.map(async (g) => {
    const ph = g.photos?.[0];
    let photo = null;
    if (ph && photoAllowed()) {
      const m = await fetch(`https://places.googleapis.com/v1/${ph.name}/media?maxWidthPx=800&skipHttpRedirect=true`, { headers: { 'X-Goog-Api-Key': key }, signal: AbortSignal.timeout(6000) }).then((x) => x.json()).catch(() => null);
      const by = ph.authorAttributions?.[0]?.displayName;
      if (m?.photoUri) photo = { url: m.photoUri, source: by ? `${by} on Google Maps` : 'Google Maps' };
    }
    return { name: g.displayName?.text, address: g.formattedAddress, area: g.shortFormattedAddress, lat: g.location?.latitude, lon: g.location?.longitude, rating: g.rating, ratings: g.userRatingCount, price: g.priceLevel ? PRICE[g.priceLevel] : null, googleMaps: g.googleMapsUri, website: g.websiteUri, photo };
  }));
  gCache.set(ck, { at: Date.now(), data: out });
  return out;
}

export async function placePreview(p) {
  const g = await googlePlace(p).catch((e) => { console.warn('[places]', e.message); return null; });
  const jobs = [];
  if (g?.photos?.length) jobs.push(Promise.resolve(g.photos));
  if (/^https?:\/\/.+\.(jpe?g|png|webp)(\?.*)?$/i.test(p.image || '')) jobs.push(Promise.resolve([{ url: p.image, source: 'OpenStreetMap' }]));
  if (p.commons) jobs.push(commonsImages(p.commons).then((a) => a.map((url) => ({ url, source: 'Wikimedia Commons' }))));
  if (p.wikidata) jobs.push(wikidataImages(p.wikidata).then((a) => a.map((url) => ({ url, source: 'Wikimedia Commons' }))));
  if (p.website) jobs.push(websiteImage(p.website).then((u) => (u ? [{ url: u, source: 'their website' }] : [])));
  const found = (await Promise.all(jobs.map((j) => j.catch(() => [])))).flat();
  const seen = new Set();
  const photos = found.filter((x) => x.url && !seen.has(x.url) && seen.add(x.url)).slice(0, 5);
  const q = encodeURIComponent(`${p.name} ${p.address || ''}`.trim());
  return {
    name: p.name, category: p.category, cuisine: p.cuisine, openingHours: p.openingHours, phone: p.phone, website: p.website,
    lat: p.lat, lon: p.lon, distance: p.distance, photos,
    rating: g?.rating, ratings: g?.ratings, address: p.address || g?.address,
    googleMaps: g?.googleMaps || `https://www.google.com/maps/search/?api=1&query=${q}`,
    directions: p.lat ? `https://maps.apple.com/?daddr=${p.lat},${p.lon}&q=${q}` : null,
  };
}
