// Speech-to-text with one interface for every platform:
//   start() / stop(), and callbacks onFinal({text}), onPartial({text}), onState({state:"idle", reason}).
// The Mac app uses Apple's speech recognizer; the web build uses Chrome's Web Speech API.
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { SpeechRecognition } from "@capgo/capacitor-speech-recognition";

// Diagnostics for a VITE_DIAG=1 build only (compiled out otherwise): timestamped recognizer
// events on the console and to a receiver on 127.0.0.1:47613. On the Mac app the receiver also
// needs NSAppTransportSecurity > NSAllowsLocalNetworking in Info.plist for that test build.
const T0 = Date.now();
export function diag(...a) {
  if (import.meta.env.VITE_DIAG !== "1") return;
  const line = "[+" + (Date.now() - T0) + "ms] " + a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ");
  console.log(line);
  // local receiver during tests; native HTTP because the web view blocks capacitor:// -> http://
  CapacitorHttp.post({ url: "http://127.0.0.1:47613/", headers: { "Content-Type": "text/plain" }, data: line }).catch(() => {});
}

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
    diag("native finish -> final", text);
    if (text.trim()) h.final({ text: text.trim() });
    h.state({ state: "idle", reason });
  }
  await SpeechRecognition.addListener("partialResults", (e) => {
    diag("native partial", { active, matches: e.matches && e.matches[0], acc: e.accumulated, accText: e.accumulatedText, forced: e.forced });
    if (!active) return;
    const current = (e.matches && e.matches[0]) || "";
    text = e.accumulatedText || [e.accumulated, current].filter(Boolean).join(" ");
    h.partial({ text });
  });
  await SpeechRecognition.addListener("listeningState", (e) => {
    diag("native state", e);
    if (e.state === "stopped" || e.status === "stopped") finish();
  });
  await SpeechRecognition.addListener("error", (e) => {
    diag("native error", e);
    const code = String((e && e.code) || "").toLowerCase();
    if (code.includes("permission") || code.includes("denied") || code.includes("not_authorized")) reason = "not_granted";
  });

  return Object.assign(api, {
    // opts.phrases: words and phrases the learner is expected to say. Apple's recognizer
    // favors them (contextualStrings), so a word said quietly at the end is still recognized.
    async start(opts = {}) {
      diag("native start: checking permission");
      let perm = await SpeechRecognition.checkPermissions();
      diag("native start: permission", perm);
      if (perm.speechRecognition !== "granted") perm = await SpeechRecognition.requestPermissions();
      if (perm.speechRecognition !== "granted") throw { code: "not_granted" };
      text = ""; reason = ""; active = true;
      diag("native start: calling plugin start", { expected: (opts.phrases || []).length });
      try {
        await SpeechRecognition.start({
          language: "en-US",
          partialResults: true,
          popup: false,
          addPunctuation: false,
          contextualStrings: opts.phrases || [],
        });
        diag("native start: plugin start resolved");
      } catch (e) { active = false; diag("native start failed", e && e.code, e && e.message); throw { code: (e && e.code) || "unavailable" }; }
    },
    async stop() {
      try { await SpeechRecognition.stop(); } catch (e) { /* already stopped */ }
      // After stop() Apple re-checks the audio and sends its final result, often with the
      // last word, up to 2 s later (the plugin's own grace period). Wait past that.
      guard = setTimeout(finish, 3000);
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
