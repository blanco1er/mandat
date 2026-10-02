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
async function getText(url, ms = 6000, max = 600000) {
  const r = await fetch(url, { headers: { ...PREVIEW_UA, Accept: 'text/html,application/json' }, signal: AbortSignal.timeout(ms), redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const t = await r.text();
  return t.slice(0, max);
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
function gKey() {
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
// Never leave the free tier: a hard cap on previews per day (each = 1 search + up to 3 photos).
const GCAP = Number(process.env.MANDAT_GOOGLE_PREVIEWS_PER_DAY || 10);
let gUse = { day: '', n: 0 };
const gCache = new Map(); // query -> { at, data }
async function googlePlace(p) {
  const key = gKey();
  if (!key) return null;
  const query = `${p.name} ${p.address || ''}`.trim();
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
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.googleMapsUri,places.photos' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) throw new Error('Google Places HTTP ' + r.status);
  const g = (await r.json()).places?.[0];
  if (!g) return null;
  // Photo URLs are fetched server-side (the key never reaches the browser) and are short-lived Google links.
  const photos = await Promise.all((g.photos || []).slice(0, 3).map(async (ph) => {
    const m = await fetch(`https://places.googleapis.com/v1/${ph.name}/media?maxWidthPx=900&skipHttpRedirect=true`, { headers: { 'X-Goog-Api-Key': key }, signal: AbortSignal.timeout(6000) }).then((x) => x.json()).catch(() => null);
    const by = ph.authorAttributions?.[0]?.displayName;
    return m?.photoUri ? { url: m.photoUri, source: by ? `${by} on Google Maps` : 'Google Maps' } : null;
  }));
  const data = { name: g.displayName?.text, address: g.formattedAddress, lat: g.location?.latitude, lon: g.location?.longitude, rating: g.rating, ratings: g.userRatingCount, googleMaps: g.googleMapsUri, photos: photos.filter(Boolean) };
  gCache.set(ck, { at: Date.now(), data });
  return data;
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
