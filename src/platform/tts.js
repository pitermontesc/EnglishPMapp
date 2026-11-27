// Text-to-speech: native voices in the Mac app, the browser's voices on the web.
// speak() resolves when the voice finishes ("end"), is interrupted ("cancelled"),
// or cannot play ("error" / "unavailable"), so callers can chain sentences.
import { Capacitor } from "@capacitor/core";
import { TextToSpeech } from "@capacitor-community/text-to-speech";

const NATIVE = Capacitor.isNativePlatform();
let webVoice = null;
let current = null; // { finish } of the utterance playing now

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
export function chunks(text) {
  return String(text).match(/[^.!?]+[.!?]*["”’)]*\s*/g) || [String(text)];
}

export function ttsAvailable() { return NATIVE || "speechSynthesis" in window; }

export function speak(text, rate = 1) {
  stop();
  return new Promise((resolve) => {
    let done = false, safety = null;
    const finish = (how) => {
      if (done) return;
      done = true; clearTimeout(safety);
      if (current && current.finish === finish) current = null;
      resolve(how);
    };
    current = { finish };
    if (NATIVE) {
      TextToSpeech.speak({ text: String(text), lang: "en-US", rate, category: "playback" })
        .then(() => finish("end"), () => finish("error"));
      return;
    }
    if (!("speechSynthesis" in window)) { finish("unavailable"); return; }
    const parts = chunks(text).map((p) => p.trim()).filter(Boolean);
    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part);
      u.lang = "en-US"; u.rate = rate;
      if (webVoice) u.voice = webVoice;
      if (i === parts.length - 1) u.onend = () => finish("end");
      u.onerror = (e) => finish(e && e.error === "interrupted" ? "cancelled" : "error");
      speechSynthesis.speak(u);
    });
    // Chrome sometimes never fires onend; never wait longer than a slow reading would take.
    safety = setTimeout(() => finish("end"), 2500 + (String(text).length * 110) / rate);
  });
}

export function stop() {
  const c = current; current = null;
  if (c) c.finish("cancelled");
  if (NATIVE) { TextToSpeech.stop().catch(() => {}); return; }
  try { speechSynthesis.cancel(); } catch (e) { /* no audio */ }
}
