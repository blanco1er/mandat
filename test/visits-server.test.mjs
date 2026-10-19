// The visit log inside the real server: a judge's path from the first page to a mission, on the simulated model
// provider and PayPal offline (no network, no key, no cost), then the developer's export. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { startMock } from './mock-provider.mjs';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a visit, end to end, in the real server', async (t) => {
  const mock = await startMock({});
  assert.match(mock.url, /^http:\/\/127\.0\.0\.1:/, 'only the local simulated provider');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mandat-visits-srv-'));
  const TOKEN = crypto.randomBytes(32).toString('hex');
  const port = await freePort();
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(R2_|PAYPAL_|GOOGLE_|CHANNEL3_|NEBIUS_|DEEPSEEK_|LLM_|ELEVEN|OPENAI|AG_STUDIO|RENDER_|PUBLIC_URL|MANDAT_)/.test(k)) delete env[k];
  Object.assign(env, {
    PORT: String(port), MANDAT_DATA: DATA, MANDAT_STORE: 'off', MANDAT_KEEPALIVE: 'off', MANDAT_MERCHANTS_AUTO: '0',
    LLM_BASE_URL: mock.url, DEEPSEEK_BASE_URL: mock.url, NEBIUS_API_KEY: 'test-key-not-real', DEEPSEEK_API_KEY: 'test-key-not-real',
    PAYPAL_KEY_FILE: '/nonexistent', CHANNEL3_KEY_FILE: '/nonexistent', GOOGLE_PLACES_KEY_FILE: '/nonexistent', VAPID_KEY_FILE: path.join(DATA, 'vapid.json'),
    MANDAT_VISITS_TOKEN: TOKEN, MANDAT_VISITS_SALT: 'test-salt',
  });
  const srv = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += d));
  t.after(() => { srv.kill(); mock.close(); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100 && !/Mandat on/.test(log); i++) await wait(100);
  assert.match(log, /Mandat on/, log);

  const H = { 'User-Agent': IPHONE, 'X-Lang': 'en' };
  let cookie = '';
  const call = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + p, { method, redirect: 'manual', headers: { ...H, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set && /mandat_uid=/.test(set)) cookie = /mandat_uid=[^;]+/.exec(set)[0];
    return r;
  };

  // A judge arrives from Devpost on an iPhone.
  assert.equal((await call('/', { headers: { Accept: 'text/html', Referer: 'https://devpost.com/software/mandat' } })).status, 200);
  const home = await (await call('/app.js')).text();
  assert.ok(home.length > 1000);
  const html = await (await call('/', { headers: { Accept: 'text/html' } })).text();
  assert.match(html, /Anonymous usage is logged to improve the demo · <a href="\/privacy">Privacy<\/a>/);
  assert.match(html, /<script src="\/visit\.js" defer><\/script>/);
  const priv = await call('/privacy', { headers: { Accept: 'text/html' } });
  assert.equal(priv.status, 200);
  assert.match(await priv.text(), /What is never logged/);
  assert.equal((await call('/visit.js')).status, 200);
  const me = await (await call('/api/me')).json();
  assert.ok(me.user.id && cookie);
  const setup = await (await call('/api/me/mandate', { method: 'POST', body: {} })).json();
  assert.ok(setup.id);
  assert.equal((await call('/mandate/return')).status, 302);
  const m = await call('/api/missions', { method: 'POST', body: { intent: 'Dinner for 4 tomorrow at 8pm, 120 €, write to lea@example.com' } });
  assert.equal(m.status, 200, await m.clone().text());
  const { id } = await m.json();
  await call(`/api/missions/${id}/messages`, { method: 'POST', body: { text: 'Call me on 06 12 34 56 78' } });
  assert.equal((await call('/api/visit', { method: 'POST', body: { t: 'leave', ms: 42000 } })).status, 204);
  await call('/api/missions/s_000000000000', {}); // an error the judge sees
  await call('/api/health');
  // The owner's script, with the header: flagged internal.
  await call('/', { headers: { Accept: 'text/html', 'X-Mandat-Internal': '1', Cookie: '' } });

  // Reading: nothing without the token.
  assert.equal((await fetch(base + '/api/visits/export')).status, 404);
  assert.equal((await fetch(base + '/api/visits/export', { headers: { Authorization: 'Bearer ' + 'f'.repeat(64) } })).status, 404);
  let ev = [];
  for (let i = 0; i < 50; i++) {
    ev = (await (await fetch(base + '/api/visits/export', { headers: { Authorization: 'Bearer ' + TOKEN } })).json()).events;
    if (ev.filter((e) => e.e === 'agent_run').length >= 2) break;
    await wait(200);
  }
  const types = ev.map((e) => e.e);
  for (const k of ['page', 'account_new', 'paypal_start', 'paypal_signed', 'mission_new', 'turn', 'agent_run', 'leave', 'error']) assert.ok(types.includes(k), `${k} in ${types}`);
  const first = ev.find((e) => e.e === 'page');
  assert.equal(first.ref, 'devpost.com');
  assert.equal(first.dev, 'mobile');
  assert.equal(first.os, 'iOS');
  assert.ok(ev.some((e) => e.e === 'page' && e.path === '/privacy'));
  assert.ok(!ev.some((e) => e.e === 'page' && /app\.js|visit\.js/.test(e.path || '')), 'files are not pages');
  assert.equal(ev.find((e) => e.e === 'mission_new').text, 'Dinner for 4 tomorrow at 8pm, 120 €, write to [email]');
  assert.equal(ev.find((e) => e.e === 'turn').text, 'Call me on [phone]');
  assert.equal(ev.find((e) => e.e === 'paypal_signed').mode, 'offline');
  assert.ok(ev.find((e) => e.e === 'error' && e.status === 404));
  const judge = ev.find((e) => e.e === 'mission_new');
  assert.equal(judge.int, undefined);
  assert.ok(ev.filter((e) => e.e === 'agent_run').every((e) => e.a === judge.a), 'the agent turns are tied to the judge');
  assert.equal(ev.filter((e) => e.int).length, 1, 'only the scripted visit is internal');
  assert.ok(!ev.some((e) => e.path === '/api/health'));
  const raw = fs.readdirSync(path.join(DATA, 'visits')).map((f) => fs.readFileSync(path.join(DATA, 'visits', f), 'utf8')).join('');
  assert.ok(!raw.includes('127.0.0.1') && !raw.includes('::1'), 'no address');
  assert.ok(!raw.includes(me.user.id), 'no account cookie');
  assert.ok(!raw.includes('lea@example.com') && !raw.includes('06 12'), 'no contact details');
  assert.ok(!raw.includes(TOKEN));
  assert.ok(!log.includes(TOKEN), 'the token is never printed');

  // The secret link: that browser is internal from then on.
  const k = crypto.createHmac('sha256', TOKEN).update('internal-link').digest('hex').slice(0, 40);
  const link = await fetch(`${base}/api/visits/internal?k=${k}`);
  assert.equal(link.status, 200);
  const ic = /mandat_internal=[^;]+/.exec(link.headers.get('set-cookie'))[0];
  await fetch(base + '/', { headers: { Accept: 'text/html', Cookie: ic, 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' } });
  ev = (await (await fetch(base + '/api/visits/export', { headers: { Authorization: 'Bearer ' + TOKEN } })).json()).events;
  assert.equal(ev[ev.length - 1].int, 1);
  assert.equal(ev[ev.length - 1].os, 'macOS');
  assert.ok(mock.requests.length > 0, 'the agent ran on the simulated provider');
});
