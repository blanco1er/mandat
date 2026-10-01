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
