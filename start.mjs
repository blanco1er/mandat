// Entry point: on the hosted demo, bring data/ back from Cloudflare R2 before the app reads it, then start.
// Locally (no R2 keys) this simply starts the server.
import path from 'node:path';
import { restore, enabled, flush, DATA } from './lib/store.mjs';

if (enabled) process.env.VAPID_KEY_FILE ||= path.join(DATA, '.vapid.json'); // push keys survive deploys too
// Restore, retried: starting empty would mint new keys and break every link and notification.
for (let attempt = 1; ; attempt++) {
  try {
    const r = await restore();
    if (r.enabled) console.log(`[store] Cloudflare R2 on · ${r.restored} files restored`);
    break;
  } catch (e) {
    console.error(`[store] restore failed (try ${attempt}):`, e.message);
    if (attempt >= 4) { if (enabled) process.exit(1); break; } // the host restarts us
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
}
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, async () => {
    await flush().catch(() => {});
    process.exit(0);
  });
}
await import('./server.mjs');

// Stay awake on the free host: Render sleeps after 15 minutes without a visit, and waking takes up to a minute.
// The server visits its own public address every 9 minutes (one always-on instance fits the 750 free hours a month).
const SELF = process.env.RENDER_EXTERNAL_URL;
if (SELF && process.env.MANDAT_KEEPALIVE !== 'off') {
  setInterval(() => {
    fetch(`${SELF}/api/health`, { signal: AbortSignal.timeout(20000) }).catch(() => {});
  }, 9 * 60 * 1000).unref();
}
