// Anonymous usage (see /privacy): when the page is left, how long it stayed open; and an error the app hit.
// Never what you type, never your PayPal details. Separate from the app, so it can never break it.
(() => {
  const t0 = Date.now();
  let sent = 0;
  const send = (body) => {
    if (sent >= 30 || !navigator.sendBeacon) return;
    sent++;
    try { navigator.sendBeacon('/api/visit', new Blob([JSON.stringify(body)], { type: 'application/json' })); } catch {}
  };
  const ours = (src) => !src || String(src).startsWith(location.origin);
  addEventListener('error', (e) => {
    if (e.message && ours(e.filename)) send({ t: 'client_error', msg: String(e.message).slice(0, 160), src: `${String(e.filename || '').replace(location.origin, '')}:${e.lineno || 0}` });
  });
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    send({ t: 'client_error', msg: String((r && r.message) || r || 'unhandled rejection').slice(0, 160) });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') send({ t: 'leave', ms: Date.now() - t0 });
  });
})();
