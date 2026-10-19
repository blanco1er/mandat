// The anonymous visit log (lib/visits.mjs): hashing, masking, the developer's exclusion, reading, retention, alert.
// No network except a local alert receiver. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mandat-visits-'));
const TOKEN = 'x'.repeat(20) + crypto.randomBytes(16).toString('hex');
Object.assign(process.env, { MANDAT_DATA: DATA, MANDAT_STORE: 'off', MANDAT_VISITS_SALT: 'salt-one', MANDAT_VISITS_TOKEN: TOKEN });
delete process.env.R2_ACCOUNT_ID;
delete process.env.MANDAT_VISITS;
const V = await import('../lib/visits.mjs');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const req = ({ ip = '203.0.113.7', ua = IPHONE, headers = {}, cookie = '', query = {}, path: p = '/', host = 'mandat.example' } = {}) => ({ ip, headers: { 'user-agent': ua, ...(cookie ? { cookie } : {}), ...headers }, query, path: p, hostname: host });
const res = () => {
  const r = { code: 200, headers: {}, body: null };
  r.status = (c) => ((r.code = c), r);
  r.set = (k, v) => ((r.headers[String(k).toLowerCase()] = v), r);
  r.setHeader = (k, v) => ((r.headers[String(k).toLowerCase()] = v), r);
  r.type = () => r;
  r.json = (b) => ((r.body = b), r);
  r.send = (b) => ((r.body = b), r);
  r.end = () => r;
  return r;
};
const lines = () => V.readEvents();
const reset = () => fs.rmSync(V.DIR, { recursive: true, force: true });

test('hashing: same address and browser give the same visitor; the address never appears', () => {
  const a = V.visitorId('203.0.113.7', IPHONE), b = V.visitorId('203.0.113.7', IPHONE);
  assert.equal(a, b);
  assert.match(a, /^v_[0-9a-f]{16}$/);
  assert.notEqual(a, V.visitorId('203.0.113.8', IPHONE));
  assert.notEqual(a, V.visitorId('203.0.113.7', MAC_CHROME));
  assert.ok(!a.includes('203'));
  // salted: the plain hash of the address is not it
  assert.ok(!crypto.createHash('sha256').update('203.0.113.7|' + IPHONE).digest('hex').startsWith(a.slice(2)));
  assert.match(V.accountId('u_0123456789abcdef'), /^a_[0-9a-f]{12}$/);
  assert.notEqual(V.accountId('u_0123456789abcdef'), 'u_0123456789abcdef');
});

test('masking: emails, phones, cards, IBAN and passwords go; dates, times and amounts stay', () => {
  const m = V.maskText;
  assert.equal(m('Write to lea.martin+test@example.com please'), 'Write to [email] please');
  assert.equal(m('Call me on 06 12 34 56 78'), 'Call me on [phone]');
  assert.equal(m('my number is +33 6 12 34 56 78.'), 'my number is [phone].');
  assert.equal(m('US: (415) 555-0134 ext'), 'US: [phone] ext');
  assert.equal(m('card 4111 1111 1111 1111 exp 12/27'), 'card [card] exp 12/27');
  assert.equal(m('pay with 4111-1111-1111-1111'), 'pay with [card]');
  assert.equal(m('IBAN FR76 3000 6000 0112 3456 7890 189 ok'), 'IBAN [iban] ok');
  assert.equal(m('my password is hunter2 ok'), 'my password is [hidden] ok');
  assert.equal(m('mot de passe : Azerty123'), 'mot de passe : [hidden]');
  assert.equal(m('token=abc.def'), 'token=[hidden]');
  const keep = 'Dinner for 4 on 2026-10-24 at 20:00, 150 € max, or 19/10/2026 20:30, budget 1 500 000';
  assert.equal(m(keep), keep);
  assert.equal(m('Birthday on 12.03.2015 for Léa'), 'Birthday on 12.03.2015 for Léa');
  assert.equal(m('line one\n\nline two'), 'line one line two');
  const long = m('a'.repeat(500));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
  assert.equal(m(null), '');
});

test('browser, system and device families; robots flagged', () => {
  assert.deepEqual(V.uaInfo(IPHONE), { br: 'Safari', os: 'iOS', dev: 'mobile' });
  assert.deepEqual(V.uaInfo(MAC_CHROME), { br: 'Chrome', os: 'macOS', dev: 'desktop' });
  assert.deepEqual(V.uaInfo('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'), { br: 'Chrome', os: 'Android', dev: 'mobile' });
  assert.deepEqual(V.uaInfo('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), { br: 'Edge', os: 'Windows', dev: 'desktop' });
  assert.deepEqual(V.uaInfo('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1').dev, 'tablet');
  assert.equal(V.uaInfo('Mozilla/5.0 (Windows NT 10.0; rv:131.0) Gecko/20100101 Firefox/131.0').br, 'Firefox');
  assert.equal(V.uaInfo('Mozilla/5.0 (compatible; Googlebot/2.1)').bot, 1);
  assert.equal(V.uaInfo('curl/8.4.0').bot, 1);
  assert.equal(V.uaInfo('').bot, 1);
  assert.equal(V.uaInfo(IPHONE).bot, undefined);
});

test('referrer: the site name only', () => {
  assert.equal(V.refOf('https://devpost.com/software/mandat?ref=abc'), 'devpost.com');
  assert.equal(V.refOf('https://www.youtube.com/watch?v=1'), 'youtube.com');
  assert.equal(V.refOf('https://m.facebook.com/'), 'facebook.com');
  assert.equal(V.refOf('https://nebiusglobalaihackathon.devpost.com/'), 'nebiusglobalaihackathon.devpost.com');
  assert.equal(V.refOf('https://mandat.example/privacy', 'mandat.example'), 'self');
  assert.equal(V.refOf(''), 'direct');
  assert.equal(V.refOf('not a url'), 'other');
});

test('an event line: no address, no browser string, no account cookie; page with its source', () => {
  reset();
  const r = req({ headers: { referer: 'https://devpost.com/software/mandat', accept: 'text/html' }, cookie: 'mandat_uid=u_0123456789abcdef', query: { utm_source: 'Devpost' } });
  V.page(r);
  V.track('mission_new', V.ctxOf(r), { mid: 's_123456789abc', text: V.maskText('Dinner, call 06 12 34 56 78'), budget: 'pill' });
  const raw = fs.readFileSync(path.join(V.DIR, fs.readdirSync(V.DIR)[0]), 'utf8');
  assert.ok(!raw.includes('203.0.113.7'));
  assert.ok(!raw.includes('iPhone OS'));
  assert.ok(!raw.includes('u_0123456789abcdef'));
  assert.ok(!raw.includes('06 12'));
  const [p, m] = lines();
  assert.equal(p.e, 'page');
  assert.equal(p.path, '/');
  assert.equal(p.ref, 'devpost.com');
  assert.equal(p.src, 'devpost');
  assert.equal(p.dev, 'mobile');
  assert.equal(p.a, V.accountId('u_0123456789abcdef'));
  assert.equal(m.text, 'Dinner, call [phone]');
  assert.equal(m.int, undefined);
  assert.equal((fs.statSync(path.join(V.DIR, fs.readdirSync(V.DIR)[0])).mode & 0o077), 0, 'the log is private to the server');
});

test('internal: the header, the secret link and its cookie; a forged cookie or wrong key does nothing', () => {
  assert.equal(V.isInternal(req({ headers: { 'x-mandat-internal': '1' } })), true);
  assert.equal(V.isInternal(req()), false);
  // the link key is derived from the token: the report script computes the same one
  const k = crypto.createHmac('sha256', TOKEN).update('internal-link').digest('hex').slice(0, 40);
  assert.equal(V.internalLinkKey(), k);
  const bad = res();
  V.internalRoute(req({ query: { k: 'nope' } }), bad);
  assert.equal(bad.code, 404);
  assert.equal(bad.headers['set-cookie'], undefined);
  const ok = res();
  V.internalRoute(req({ query: { k } }), ok);
  assert.equal(ok.code, 200);
  const cookie = /mandat_internal=([0-9a-f]{40})/.exec(ok.headers['set-cookie'])[1];
  assert.match(ok.headers['set-cookie'], /HttpOnly/);
  assert.equal(V.isInternal(req({ cookie: `mandat_uid=u_1; mandat_internal=${cookie}` })), true);
  assert.equal(V.isInternal(req({ cookie: 'mandat_internal=' + 'a'.repeat(40) })), false);
  assert.equal(V.isInternal(req({ cookie: 'mandat_internal=1' })), false);
  reset();
  V.page(req({ cookie: `mandat_internal=${cookie}`, headers: { accept: 'text/html' } }));
  assert.equal(lines()[0].int, 1);
});

test('background events follow the account: internal stays internal', () => {
  reset();
  V.linkUser(req({ headers: { 'x-mandat-internal': '1' } }), 'u_aaaaaaaaaaaaaaaa');
  const b = V.watch({ s: { id: 's_aaaaaaaaaaaa', userId: 'u_aaaaaaaaaaaaaaaa', envelope: { currency: 'EUR', entries: [] } } });
  V.observe(b, 'tool', { name: 'search_places', args: { q: 'secret plans' } });
  const [e] = lines();
  assert.equal(e.e, 'tool');
  assert.equal(e.name, 'search_places');
  assert.equal(e.int, 1);
  assert.equal(e.args, undefined, 'tool arguments are never logged');
  assert.equal(V.ctxForUser('u_unknown0000000').a, V.accountId('u_unknown0000000'));
});

test('agent steps: plan once, approval shown and answered once, every payment state', () => {
  reset();
  V.linkUser(req(), 'u_bbbbbbbbbbbbbbbb');
  const s = { id: 's_bbbbbbbbbbbb', userId: 'u_bbbbbbbbbbbbbbbb', envelope: { currency: 'EUR', entries: [{ id: 'old', state: 'captured', amount: 9 }] } };
  const b = V.watch({ s });
  V.observe(b, 'plan', { items: [{}, {}] });
  V.observe(b, 'plan', { items: [{}, {}, {}] });
  V.observe(b, 'approval', { id: 'ap1', amount: 120, status: 'pending' });
  V.observe(b, 'approval', { id: 'ap1', amount: 120, status: 'pending' });
  V.observe(b, 'approval_resolved', { id: 'ap1', approved: true });
  V.observe(b, 'approval_resolved', { id: 'ap1', approved: true });
  s.envelope.entries.push({ id: 'e1', state: 'held', amount: 120, paypal: { mode: 'sandbox', authorizationId: 'AUTH-SECRET' } });
  V.observe(b, 'payment', { kind: 'hold' });
  s.envelope.entries[1].state = 'captured';
  V.observe(b, 'envelope', {});
  s.envelope.entries[1].refunded = 20;
  V.observe(b, 'envelope', {});
  s.envelope.entries.push({ id: 'e2', state: 'held', amount: 30 });
  V.observe(b, 'envelope', {});
  s.envelope.entries[2].state = 'released';
  V.observe(b, 'envelope', {});
  V.observe(b, 'error', { message: 'PayPal said no to lea@x.com' });
  const ev = lines();
  assert.deepEqual(ev.map((e) => e.e), ['plan', 'approval_shown', 'approval_answer', 'payment', 'payment', 'payment', 'payment', 'payment', 'error']);
  assert.deepEqual(ev.filter((e) => e.e === 'payment').map((e) => [e.state, e.amount]), [['authorized', 120], ['captured', 120], ['refunded', 20], ['authorized', 30], ['voided', 30]]);
  assert.equal(ev[3].mode, 'sandbox');
  assert.ok(!JSON.stringify(ev).includes('AUTH-SECRET'));
  assert.equal(ev[8].msg, 'PayPal said no to [email]');
});

test('export: only with the long token; a token that is too short turns it off', () => {
  const ok = res();
  V.exportRoute(req({ headers: { authorization: 'Bearer ' + TOKEN } }), ok);
  assert.equal(ok.code, 200);
  assert.ok(Array.isArray(ok.body.events) && ok.body.events.length > 0);
  assert.equal(ok.body.storage, 'disk');
  for (const h of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }, { authorization: 'Bearer ' + TOKEN + 'x' }]) {
    const r = res();
    V.exportRoute(req({ ip: '198.51.100.1', headers: h }), r);
    assert.equal(r.code, 404);
    assert.equal(r.body.events, undefined);
  }
  const saved = process.env.MANDAT_VISITS_TOKEN;
  process.env.MANDAT_VISITS_TOKEN = 'short';
  const r = res();
  V.exportRoute(req({ ip: '198.51.100.2', headers: { authorization: 'Bearer short' } }), r);
  assert.equal(r.code, 404);
  assert.equal(V.internalLinkKey(), '');
  process.env.MANDAT_VISITS_TOKEN = saved;
  // too many wrong tries from one address: refused for the hour
  for (let i = 0; i < 25; i++) V.exportRoute(req({ ip: '198.51.100.3' }), res());
  const late = res();
  V.exportRoute(req({ ip: '198.51.100.3', headers: { authorization: 'Bearer ' + TOKEN } }), late);
  assert.equal(late.code, 429);
});

test('beacons: time on page and app errors only, capped', () => {
  reset();
  const r = () => Object.assign(req(), { body: { t: 'leave', ms: 125000.4 } });
  V.beaconRoute(r(), res());
  V.beaconRoute(Object.assign(req(), { body: { t: 'client_error', msg: 'x is undefined for 4111 1111 1111 1111', src: '/app.js:12<script>' } }), res());
  V.beaconRoute(Object.assign(req(), { body: { t: 'anything', text: 'secret' } }), res());
  const ev = lines();
  assert.deepEqual(ev.map((e) => e.e), ['leave', 'client_error']);
  assert.equal(ev[0].ms, 125000);
  assert.equal(ev[1].msg, 'x is undefined for [card]');
  assert.equal(ev[1].src, '/app.js:12script');
  for (let i = 0; i < 100; i++) V.beaconRoute(r(), res());
  assert.ok(lines().length <= 61);
});

test('retention: kept at least until 31 January 2027, deleted after the deletion date, only visit files', () => {
  reset();
  fs.mkdirSync(V.DIR, { recursive: true });
  for (const d of ['2026-10-19', '2026-12-15', '2027-03-31', '2027-04-02']) fs.writeFileSync(path.join(V.DIR, d + '.jsonl'), '{}\n');
  fs.writeFileSync(path.join(V.DIR, 'notes.txt'), 'keep');
  const kept = () => fs.readdirSync(V.DIR).sort();
  delete process.env.MANDAT_VISITS_DELETE_AFTER;
  assert.equal(V.deleteAfter(), '2027-03-31');
  assert.equal(V.purge(new Date('2026-12-31T12:00:00Z')), 0);
  assert.equal(V.purge(new Date('2027-01-31T23:59:00Z')), 0);
  assert.equal(V.purge(new Date('2027-03-31T23:59:00Z')), 0);
  assert.equal(kept().length, 5);
  // a deletion date set too early is moved to the end of January
  process.env.MANDAT_VISITS_DELETE_AFTER = '2026-11-01';
  assert.equal(V.deleteAfter(), '2027-01-31');
  assert.equal(V.purge(new Date('2027-01-31T10:00:00Z')), 0);
  process.env.MANDAT_VISITS_DELETE_AFTER = 'nonsense';
  assert.equal(V.deleteAfter(), '2027-03-31');
  delete process.env.MANDAT_VISITS_DELETE_AFTER;
  assert.equal(V.purge(new Date('2027-04-01T00:01:00Z')), 3);
  assert.deepEqual(kept(), ['2027-04-02.jsonl', 'notes.txt']);
});

test('a day file has a size cap; MANDAT_VISITS=off writes nothing', () => {
  reset();
  process.env.MANDAT_VISITS_MAX_MB = '0.0001'; // 100 bytes
  for (let i = 0; i < 10; i++) V.track('page', {}, { path: '/' });
  assert.ok(lines().length < 10);
  delete process.env.MANDAT_VISITS_MAX_MB;
  reset();
  process.env.MANDAT_VISITS = 'off';
  V.track('page', {}, { path: '/' });
  assert.equal(lines().length, 0);
  delete process.env.MANDAT_VISITS;
});

test('alert: a new outside visitor with a mission, at most once per period; never for internal or robots', async () => {
  const got = [];
  const srv = http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { got.push({ title: q.headers.title, body: b }); r.end('ok'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.MANDAT_VISITS_ALERT_URL = `http://127.0.0.1:${srv.address().port}/topic`;
  process.env.MANDAT_VISITS_ALERT_EVERY_MS = '400';
  reset();
  const ext1 = req({ ip: '192.0.2.1', headers: { referer: 'https://devpost.com/x', accept: 'text/html' } });
  V.page(ext1);
  V.track('mission_new', V.ctxOf(ext1), { mid: 's_1' });
  V.track('mission_new', V.ctxOf(ext1), { mid: 's_2' }); // same visitor: not new
  V.track('mission_new', V.ctxOf(req({ ip: '192.0.2.9', headers: { 'x-mandat-internal': '1' } })), { mid: 's_3' });
  V.track('mission_new', V.ctxOf(req({ ip: '192.0.2.8', ua: 'curl/8' })), { mid: 's_4' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(got.length, 1);
  assert.match(got[0].body, /1 nouveau visiteur externe/);
  assert.match(got[0].body, /devpost\.com/);
  assert.ok(!got[0].body.includes('192.0.2'));
  // two more within the period: one grouped alert when the period is over
  V.track('mission_new', V.ctxOf(req({ ip: '192.0.2.2' })), { mid: 's_5' });
  V.track('mission_new', V.ctxOf(req({ ip: '192.0.2.3' })), { mid: 's_6' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(got.length, 1);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(got.length, 2);
  assert.match(got[1].body, /2 nouveaux visiteurs externes/);
  delete process.env.MANDAT_VISITS_ALERT_URL;
  srv.close();
});

test('the report script reads local files, in French, without the developer', () => {
  reset();
  const ext = req({ ip: '192.0.2.50', headers: { referer: 'https://devpost.com/software/mandat', accept: 'text/html' } });
  V.page(ext);
  V.track('account_new', V.linkUser(ext, 'u_cccccccccccccccc'));
  V.track('paypal_signed', V.linkUser(ext, 'u_cccccccccccccccc'), { mode: 'sandbox' });
  V.track('mission_new', V.ctxOf(ext), { mid: 's_cccccccccccc', text: 'Dinner for 4 on Saturday, 150 €', budget: 'words' });
  const b = V.watch({ s: { id: 's_cccccccccccc', userId: 'u_cccccccccccccccc', envelope: { currency: 'EUR', entries: [] } } });
  V.observe(b, 'plan', { items: [{}] });
  V.track('error', V.ctxOf(ext), { where: 'POST /api/missions', status: 429, msg: 'Daily limit' });
  const me = req({ ip: '192.0.2.60', headers: { 'x-mandat-internal': '1', accept: 'text/html' } });
  V.page(me);
  V.track('mission_new', V.ctxOf(me), { mid: 's_dddddddddddd', text: 'Owner test mission' });
  const run = (...a) => execFileSync(process.execPath, [path.resolve('scripts/visits-report.mjs'), '--fichier', V.DIR, ...a], { encoding: 'utf8', env: { ...process.env, MANDAT_VISITS_TOKEN: '' } });
  const out = run();
  assert.match(out, /Personnes uniques : 1/);
  assert.match(out, /1 personne\(s\) interne\(s\)/);
  assert.match(out, /devpost\.com/);
  assert.match(out, /Dinner for 4 on Saturday, 150 €/);
  assert.ok(!out.includes('Owner test mission'));
  assert.match(out, /a vu le plan de l'agent/);
  assert.match(out, /Daily limit/);
  assert.match(out, /téléphone iOS Safari/);
  const all = run('--tout');
  assert.match(all, /Owner test mission/);
  const one = run('--session', V.visitorId('192.0.2.50', IPHONE).slice(0, 6));
  assert.match(one, /connexion PayPal sandbox réussie/);
  assert.match(one, /plan affiché/);
  const later = run('--depuis', '2999-01-01');
  assert.match(later, /Personnes uniques : 0/);
});

test('the log never gets in the app\'s way: odd inputs do not throw', () => {
  assert.doesNotThrow(() => V.observe({ s: { id: 's_x', envelope: null } }, 'payment', null));
  assert.doesNotThrow(() => V.observe(null, 'tool', {}));
  assert.doesNotThrow(() => V.observe({ s: { id: 's_y', envelope: { entries: [null] } } }, 'envelope'));
  assert.deepEqual(V.ctxOf({ get headers() { throw new Error('boom'); } }), {});
  assert.doesNotThrow(() => V.linkUser({ get headers() { throw new Error('boom'); } }, 'u_1'));
  assert.equal(V.page({ get headers() { throw new Error('boom'); } }), null);
});
