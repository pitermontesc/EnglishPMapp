// Speech-to-text with one interface for every platform:
//   start() / stop(), and callbacks onFinal({text}), onPartial({text}), onState({state:"idle", reason}).
// Native apps use the OS recognizer (Apple Speech on iOS and Mac, Google on Android).
// The web build uses the Web Speech API (Chrome, Edge, Safari).
import { Capacitor } from "@capacitor/core";
import { SpeechRecognition } from "@capgo/capacitor-speech-recognition";

export async function createDictation() {
  return Capacitor.isNativePlatform() ? nativeDictation() : webDictation();
}

function handlers() {
  const h = { final() {}, partial() {}, state() {} };
  return {
    h,
    api: {
      onFinal(fn) { h.final = fn; },
      onPartial(fn) { h.partial = fn; },
      onState(fn) { h.state = fn; },
    },
  };
}

async function nativeDictation() {
  let ok = false;
  try { ok = (await SpeechRecognition.available()).available; } catch (e) { ok = false; }
  if (!ok) return null;
  const { h, api } = handlers();
  let active = false, text = "", reason = "", guard = null;

  function finish() {
    if (!active) return;
    active = false; clearTimeout(guard);
    if (text.trim()) h.final({ text: text.trim() });
    h.state({ state: "idle", reason });
  }
  await SpeechRecognition.addListener("partialResults", (e) => {
    if (!active) return;
    const current = (e.matches && e.matches[0]) || "";
    text = e.accumulatedText || [e.accumulated, current].filter(Boolean).join(" ");
    h.partial({ text });
  });
  await SpeechRecognition.addListener("listeningState", (e) => {
    if (e.state === "stopped" || e.status === "stopped") finish();
  });
  await SpeechRecognition.addListener("error", (e) => {
    const code = String((e && e.code) || "").toLowerCase();
    if (code.includes("permission") || code.includes("denied") || code.includes("not_authorized")) reason = "not_granted";
  });

  return Object.assign(api, {
    async start() {
      let perm = await SpeechRecognition.checkPermissions();
      if (perm.speechRecognition !== "granted") perm = await SpeechRecognition.requestPermissions();
      if (perm.speechRecognition !== "granted") throw { code: "not_granted" };
      text = ""; reason = ""; active = true;
      try {
        await SpeechRecognition.start({
          language: "en-US",
          partialResults: true,
          popup: false,
          addPunctuation: false,
          // Android 13+: keep listening through pauses until Stop is pressed.
          keepListeningMs: Capacitor.getPlatform() === "android" ? 120000 : undefined,
        });
      } catch (e) { active = false; throw { code: (e && e.code) || "unavailable" }; }
    },
    async stop() {
      try { await SpeechRecognition.stop(); } catch (e) { /* already stopped */ }
      // If the recognizer never reports "stopped", close the take anyway.
      guard = setTimeout(finish, 1500);
    },
  });
}

function webDictation() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const { h, api } = handlers();
  let r = null;
  return Object.assign(api, {
    async start() {
      r = new SR();
      r.lang = "en-US"; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
      let reason = "";
      r.onresult = (ev) => {
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (res.isFinal) h.final({ text: res[0].transcript.trim() + " " });
          else interim += res[0].transcript;
        }
        h.partial({ text: interim });
      };
      r.onerror = (ev) => {
        if (ev.error === "not-allowed" || ev.error === "service-not-allowed") reason = "not_granted";
        else if (ev.error === "audio-capture") reason = "no_microphone";
        else if (ev.error === "network") reason = "network";
      };
      r.onend = () => { r = null; h.state({ state: "idle", reason }); };
      r.start();
    },
    async stop() { if (r) r.stop(); },
  });
}
