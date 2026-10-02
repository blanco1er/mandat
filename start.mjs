// Entry point: on the hosted demo, bring data/ back from Cloudflare R2 before the app reads it, then start.
// Locally (no R2 keys) this simply starts the server.
import path from 'node:path';
import { restore, enabled, flush, DATA } from './lib/store.mjs';

if (enabled) process.env.VAPID_KEY_FILE ||= path.join(DATA, '.vapid.json'); // push keys survive deploys too
try {
  const r = await restore();
  if (r.enabled) console.log(`[store] Cloudflare R2 on · ${r.restored} files restored`);
} catch (e) {
  console.error('[store] restore failed, starting with what is on disk:', e.message);
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, async () => {
    await flush().catch(() => {});
    process.exit(0);
  });
}
await import('./server.mjs');
