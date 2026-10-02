// Durable storage for the hosted demo: every file under data/ is mirrored to a Cloudflare R2 bucket
// (S3 API, signed by hand: no dependency), and restored at start. Free hosts wipe their disk on each
// deploy and restart; with this, accounts, missions, photos and push keys survive.
// On when R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are set (the host), or with MANDAT_STORE=r2 and the
// private key file (a test on the Mac). Off otherwise: local development keeps its own data/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA = path.resolve(process.env.MANDAT_DATA || 'data');
const FILE = process.env.R2_KEY_FILE || path.join(os.homedir(), 'Library/Application Support/StudioPilot/secrets/r2-mandat.json');
function conf() {
  if (process.env.R2_ACCOUNT_ID) return { account: process.env.R2_ACCOUNT_ID, id: process.env.R2_ACCESS_KEY_ID, secret: process.env.R2_SECRET_ACCESS_KEY, bucket: process.env.R2_BUCKET || 'mandat-data' };
  if (process.env.MANDAT_STORE !== 'r2') return null; // on a Mac, the local test data never mixes with the hosted demo's
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { account: j.account_id, id: j.access_key_id, secret: j.secret_access_key, bucket: j.bucket || 'mandat-data' };
  } catch {
    return null;
  }
}
const C = conf();
export const enabled = !!(C?.account && C.id && C.secret) && process.env.MANDAT_STORE !== 'off';
const PREFIX = process.env.R2_PREFIX || 'v1/';
const SKIP = /(^|\/)(osm-cache\.json|.*\.tmp)$/;

// ---------- AWS Signature V4 (service "s3", region "auto") ----------
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
async function s3(method, key = '', { body = Buffer.alloc(0), query = {}, type } = {}) {
  const host = `${C.account}.r2.cloudflarestorage.com`;
  const pathname = `/${C.bucket}${key ? '/' + key.split('/').map(enc).join('/') : ''}`;
  const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join('&');
  const now = new Date();
  const amz = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amz.slice(0, 8);
  const hash = sha(body);
  const headers = { host, 'x-amz-content-sha256': hash, 'x-amz-date': amz, ...(type ? { 'content-type': type } : {}) };
  const names = Object.keys(headers).sort();
  const canonical = [method, pathname, qs, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), hash].join('\n');
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac('AWS4' + C.secret, day), 'auto'), 's3'), 'aws4_request');
  const auth = `AWS4-HMAC-SHA256 Credential=${C.id}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(kSign, toSign).toString('hex')}`;
  const res = await fetch(`https://${host}${pathname}${qs ? '?' + qs : ''}`, {
    method, headers: { ...headers, authorization: auth }, body: method === 'PUT' ? body : undefined, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw new Error(`R2 ${method} ${key || '/'}: HTTP ${res.status}`);
  return res;
}

// ---------- restore at start ----------
export async function restore() {
  if (!enabled) return { enabled: false };
  let token, n = 0;
  do {
    const xml = await (await s3('GET', '', { query: { 'list-type': 2, prefix: PREFIX, ...(token ? { 'continuation-token': token } : {}) } })).text();
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([^<]+)</)?.[1] : null;
    await Promise.all(keys.map(async (k) => {
      const rel = k.slice(PREFIX.length);
      if (!rel || rel.includes('..')) return;
      const buf = Buffer.from(await (await s3('GET', k)).arrayBuffer());
      const f = path.join(DATA, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, buf, { mode: 0o600 });
      n++;
    }));
  } while (token);
  return { enabled: true, restored: n };
}

// ---------- mirror each write (debounced per file, retried) ----------
const pending = new Map();
const relOf = (file) => path.relative(DATA, path.resolve(file)).split(path.sep).join('/');
export function persist(file) {
  if (!enabled) return;
  const rel = relOf(file);
  if (rel.startsWith('..') || SKIP.test(rel)) return;
  clearTimeout(pending.get(rel));
  pending.set(rel, setTimeout(() => upload(rel, 0), 700));
}
async function upload(rel, attempt) {
  pending.delete(rel);
  const f = path.join(DATA, rel);
  try {
    if (!fs.existsSync(f)) return await s3('DELETE', PREFIX + rel);
    await s3('PUT', PREFIX + rel, { body: fs.readFileSync(f), type: rel.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
  } catch (e) {
    if (attempt < 3) setTimeout(() => upload(rel, attempt + 1), 2000 * (attempt + 1));
    else console.warn('[store]', e.message);
  }
}
export const forget = (file) => persist(file); // the file is gone: upload() deletes it
// Before a planned shutdown, send what is still waiting.
export async function flush() {
  const rels = [...pending.keys()];
  for (const r of rels) clearTimeout(pending.get(r));
  await Promise.all(rels.map((r) => upload(r, 3)));
}
