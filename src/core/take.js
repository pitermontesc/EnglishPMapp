// When a reading "take" ends: pure decisions, so they can be unit tested without a microphone.
import { align, alignPrefix } from "./text.js";

// How long the microphone waits in silence before closing the take (Settings → Reading).
export const PAUSES = { short: 0.6, normal: 1, long: 1.6 };
export function pauseFactor(setting) { return PAUSES[setting] || 1; }

// Progress of a take against the target sentence (both as word lists).
// okIdx: sentence positions recognized so far. finished: the sentence's last word is also the
// last word heard and most of the sentence was read, so the take can close soon.
export function takeProgress(target, heard) {
  const res = alignPrefix(target, heard), okIdx = [];
  res.forEach((r, i) => { if (r && r.ok) okIdx.push(i); });
  const last = res[res.length - 1];
  const coverage = target.length ? heard.length / target.length : 0;
  const finished = !!(last && last.ok && heard[heard.length - 1] === target[target.length - 1] && coverage >= 0.75);
  return { okIdx, finished, coverage };
}
// Silence (ms) that closes the take after the last recognized text.
export function silenceWait(finished, coverage, factor) {
  return (finished ? 1000 : coverage >= 0.5 ? 2400 : 3400) * factor;
}

// Voice activity from the microphone level (0..1 = -50..0 dBFS, about 15 readings a second).
// The room's noise floor drops at once to the quietest reading and rises slowly, so steady
// background noise is not taken for a voice.
export const VOICE_ABOVE_NOISE = 0.15; // 7.5 dB over the room
export function createVoiceMeter() {
  const m = { floor: null, lastVoice: 0, hasLevels: false, voice: false };
  // Returns { voice, changed, ring } where ring (0..1) drives the button's visual ring.
  m.update = (level, now) => {
    m.hasLevels = true;
    if (m.floor == null || level < m.floor) m.floor = level;
    else m.floor += (level - m.floor) * 0.002;
    const voice = level > m.floor + VOICE_ABOVE_NOISE;
    if (voice) m.lastVoice = now;
    const changed = voice !== m.voice; m.voice = voice;
    return { voice, changed, ring: Math.max(0, Math.min(1, (level - m.floor) / 0.35)) };
  };
  // Has the voice been quiet for `hold` ms? If not, how much longer to wait.
  // Without level readings (the web version) a pause in the text is all there is: quiet.
  m.quietFor = (now, hold) => {
    if (!m.hasLevels) return { quiet: true, waitMore: 0 };
    const since = now - m.lastVoice;
    return since >= hold ? { quiet: true, waitMore: 0 } : { quiet: false, waitMore: hold - since + 100 };
  };
  return m;
}

// Which text to show and grade when the take ends: Apple's final text, unless an earlier
// hypothesis recognized more of the sentence (its final re-ranking sometimes drops words).
export function bestShown(target, finalText, finalWords, bestText, bestOk) {
  if (!target || !bestText) return finalText;
  const finalOk = align(target, finalWords).filter((x) => x.ok).length;
  return bestOk > finalOk ? bestText : finalText;
}
