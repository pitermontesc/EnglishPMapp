// Text-to-speech: native voices in the apps, the browser's voices on the web.
import { Capacitor } from "@capacitor/core";
import { TextToSpeech } from "@capacitor-community/text-to-speech";

const NATIVE = Capacitor.isNativePlatform();
let webVoice = null;

function pickWebVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = speechSynthesis.getVoices().filter((v) => /^en[-_]US/i.test(v.lang));
  const prefer = [/natural/i, /premium|enhanced/i, /google us english/i, /samantha/i, /ava|allison|aaron|evan|nicky/i];
  for (const re of prefer) { const v = voices.find((x) => re.test(x.name)); if (v) return v; }
  return voices[0] || null;
}
if (!NATIVE && "speechSynthesis" in window) {
  webVoice = pickWebVoice();
  speechSynthesis.onvoiceschanged = () => { webVoice = pickWebVoice(); };
}

// Long text is spoken sentence by sentence: Chrome cuts off single utterances after ~15 s.
function chunks(text) {
  return String(text).match(/[^.!?]+[.!?]*["”’)]*\s*/g) || [String(text)];
}

export function ttsAvailable() { return NATIVE || "speechSynthesis" in window; }

export function speak(text, rate = 1) {
  stop();
  if (NATIVE) {
    return TextToSpeech.speak({ text: String(text), lang: "en-US", rate, category: "playback" }).catch(() => {});
  }
  if (!("speechSynthesis" in window)) return Promise.reject({ code: "unavailable" });
  for (const part of chunks(text)) {
    const u = new SpeechSynthesisUtterance(part.trim());
    u.lang = "en-US"; u.rate = rate;
    if (webVoice) u.voice = webVoice;
    speechSynthesis.speak(u);
  }
  return Promise.resolve();
}

export function stop() {
  if (NATIVE) { TextToSpeech.stop().catch(() => {}); return; }
  try { speechSynthesis.cancel(); } catch (e) { /* no audio */ }
}
