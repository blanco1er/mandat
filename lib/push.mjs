// Web Push notifications (free, standard): "needs you" moments reach the phone even when Mandat is closed.
// Keys (VAPID) come from the environment when hosted, or a private 600-mode file locally (created once).
import fs from 'node:fs';
import { persist } from './store.mjs';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';

const KEY_FILE = process.env.VAPID_KEY_FILE || path.join(os.homedir(), 'Library/Application Support/StudioPilot/secrets/mandat-vapid.json');
let keys = null;
function vapid() {
  if (keys) return keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  else {
    try {
      keys = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    } catch {
      keys = webpush.generateVAPIDKeys();
      fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
      fs.writeFileSync(KEY_FILE, JSON.stringify(keys), { mode: 0o600 });
      persist(KEY_FILE);
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:hello@mandat.app', keys.publicKey, keys.privateKey);
  return keys;
}
export const publicKey = () => vapid().publicKey;

// Send to every device of a user; forget devices the push service says are gone.
export async function notify(user, { title, body, url = '/', tag, badge }) {
  if (!user?.push?.length) return false;
  vapid();
  const payload = JSON.stringify({ title, body, url, tag, badge });
  const gone = [];
  await Promise.all(user.push.map((sub) => webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high', topic: tag?.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '') || undefined })
    .catch((e) => { if (e.statusCode === 404 || e.statusCode === 410) gone.push(sub.endpoint); else console.warn('[push]', e.statusCode || e.message); })));
  if (gone.length) user.push = user.push.filter((s) => !gone.includes(s.endpoint));
  return gone.length > 0; // true → the caller should save the user
}
