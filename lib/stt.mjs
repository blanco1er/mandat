// Speech to text for the voice conversation: the app records you (a short WAV, 16 kHz mono, sent when you
// stop talking) and Google Cloud Speech-to-Text writes it down. iPhone's own recognition goes deaf once the
// page has played a sound; recording ourselves works on every phone. Same Google key as the voice.
// Guarded: seconds per person and per day, a global daily cap.
import { gKey } from './places.mjs';

const PER_USER = Number(process.env.MANDAT_STT_SECONDS_PER_USER_DAY) || 900;
const GLOBAL = Number(process.env.MANDAT_STT_SECONDS_PER_DAY) || 7200;
let day = '', used = 0, perUser = new Map();
let pausedUntil = 0; // Google refused (API off, key restricted, quota): the phone's recognition takes over

export const sttEnabled = () => !!gKey() && Date.now() > pausedUntil;

export async function transcribe(wavBase64, lang, userId) {
  if (!sttEnabled()) throw Object.assign(new Error('stt_off'), { status: 503 });
  const audio = String(wavBase64 || '');
  if (!/^[A-Za-z0-9+/=]+$/.test(audio) || audio.length < 2000) throw Object.assign(new Error('no audio'), { status: 400 });
  const seconds = Math.ceil(((audio.length * 3) / 4 - 44) / 32000); // 16 kHz, 16-bit mono
  if (seconds > 40) throw Object.assign(new Error('too long'), { status: 413 });
  const today = new Date().toISOString().slice(0, 10);
  if (day !== today) { day = today; used = 0; perUser = new Map(); }
  const mine = perUser.get(userId) || 0;
  if (used + seconds > GLOBAL || mine + seconds > PER_USER) throw Object.assign(new Error('stt_cap'), { status: 429 });
  const r = await fetch('https://speech.googleapis.com/v1/speech:recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': gKey() },
    body: JSON.stringify({
      config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: lang === 'fr' ? 'fr-FR' : 'en-US', alternativeLanguageCodes: [lang === 'fr' ? 'en-US' : 'fr-FR'], enableAutomaticPunctuation: true, model: 'latest_short' },
      audio: { content: audio },
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) {
    if ([401, 403, 429].includes(r.status) || r.status >= 500) pausedUntil = Date.now() + (r.status >= 500 ? 2 : 30) * 60000;
    throw Object.assign(new Error('stt_http_' + r.status), { status: 503 });
  }
  used += seconds;
  perUser.set(userId, mine + seconds);
  const j = await r.json();
  return (j.results || []).map((x) => x.alternatives?.[0]?.transcript || '').join(' ').replace(/\s+/g, ' ').trim();
}

// Is Google's recognition open for this key? Asked at start and every 30 minutes with half a second of
// silence (free of charge), so the app knows which way to listen before anyone speaks.
let probed = false;
async function probe() {
  if (!gKey()) return;
  try {
    const silence = Buffer.alloc(16000).toString('base64');
    const r = await fetch('https://speech.googleapis.com/v1/speech:recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': gKey() },
      body: JSON.stringify({ config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'fr-FR' }, audio: { content: silence } }),
      signal: AbortSignal.timeout(10000),
    });
    pausedUntil = r.ok ? 0 : Date.now() + 5 * 60000;
    if (!probed || !r.ok) console.log(`[stt] Google speech-to-text ${r.ok ? 'on' : 'off (' + r.status + '), the phone recognition is used'}`);
  } catch {}
  probed = true;
}
setTimeout(probe, 2000);
// every 5 minutes while it is off (it may just have been switched on), every 30 once it works
setInterval(() => { if (Date.now() < pausedUntil || Date.now() % (30 * 60000) < 5 * 60000) probe(); }, 5 * 60000).unref?.();
