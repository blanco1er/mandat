// A human-sounding voice for the voice conversation: Google Cloud Text-to-Speech (Chirp 3 HD voices),
// one sentence at a time so speech starts quickly. Same Google key as the place previews.
// Guarded: characters per person and per day, a global daily cap, and a cache of what was already said.
import crypto from 'node:crypto';
import { gKey } from './places.mjs';

const VOICES = {
  fr: { languageCode: 'fr-FR', name: process.env.MANDAT_VOICE_FR || 'fr-FR-Chirp3-HD-Aoede' },
  en: { languageCode: 'en-US', name: process.env.MANDAT_VOICE_EN || 'en-US-Chirp3-HD-Aoede' },
};
const PER_USER = Number(process.env.MANDAT_TTS_CHARS_PER_USER_DAY) || 12000;
const GLOBAL = Number(process.env.MANDAT_TTS_CHARS_PER_DAY) || 150000;
let day = '', used = 0, perUser = new Map();
const cache = new Map(); // text hash -> mp3 (most recent 300)
let pausedUntil = 0; // Google refused (API off, quota, key): use the phone's voice for a while

export const ttsEnabled = () => !!gKey() && Date.now() > pausedUntil;

export async function synthesize(text, lang, userId) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!clean) throw Object.assign(new Error('empty'), { status: 400 });
  if (!ttsEnabled()) throw Object.assign(new Error('tts_off'), { status: 503 });
  const v = VOICES[lang] || VOICES.en;
  const key = crypto.createHash('sha1').update(v.name + '|' + clean).digest('hex');
  if (cache.has(key)) return cache.get(key);
  const today = new Date().toISOString().slice(0, 10);
  if (day !== today) { day = today; used = 0; perUser = new Map(); }
  const mine = perUser.get(userId) || 0;
  if (used + clean.length > GLOBAL || mine + clean.length > PER_USER) throw Object.assign(new Error('tts_cap'), { status: 429 });
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': gKey() },
    body: JSON.stringify({ input: { text: clean }, voice: v, audioConfig: { audioEncoding: 'MP3' } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    if ([400, 401, 403, 429].includes(r.status) || r.status >= 500) pausedUntil = Date.now() + (r.status >= 500 ? 2 : 30) * 60000;
    throw Object.assign(new Error('tts_http_' + r.status), { status: 503 });
  }
  const mp3 = Buffer.from((await r.json()).audioContent || '', 'base64');
  used += clean.length;
  perUser.set(userId, mine + clean.length);
  cache.set(key, mp3);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return mp3;
}
