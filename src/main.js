// Daily English: standalone app for Chrome (web) and Mac.
// Same lesson flow as the Claude artifact (artifact/index.html), with the artifact's
// runtime capabilities replaced by platform adapters in ./platform.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/500.css";
import "@fontsource/newsreader/600.css";
import "@fontsource/newsreader/400-italic.css";
import "./styles.css";

import { Capacitor } from "@capacitor/core";
import { openStore, store, getSetting, setSettings } from "./platform/storage.js";
import { createDictation, diag, micLog } from "./platform/speech.js";
import { speak, stop as stopSpeech, ttsAvailable } from "./platform/tts.js";
import { createAI, MODELS, DEFAULT_MODEL } from "./platform/ai.js";
import { saveTextFile } from "./platform/files.js";
import STARTER from "./lessons/starter.json";

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function pad(n) { return (n < 10 ? "0" : "") + n; }
function dateKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function addDays(key, n) { const p = key.split("-"); const d = new Date(+p[0], +p[1] - 1, +p[2]); d.setDate(d.getDate() + n); return dateKey(d); }
const TODAY = dateKey(new Date());
const INTERVALS = [1, 3, 7, 14, 30];
const PLATFORM = Capacitor.getPlatform(); // "web" or "ios" (the Mac app is the iOS build running on Apple Silicon)

// ---------- pure text helpers ----------
function norm(w) { return String(w).toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9']/g, "").replace(/^'+|'+$/g, ""); }
function words(text) { return String(text).split(/[\s—–\-/]+/).map(norm).filter(Boolean); }
function docId(w) { return norm(w).replace(/[^a-z0-9]/g, "_") || "_"; }
// Align what was heard against the target sentence (edit distance with backtrace).
function align(target, heard) {
  const n = target.length, m = heard.length, dp = [];
  let i, j;
  for (i = 0; i <= n; i++) { dp.push(new Array(m + 1)); dp[i][0] = i; }
  for (j = 0; j <= m; j++) dp[0][j] = j;
  for (i = 1; i <= n; i++) for (j = 1; j <= m; j++) {
    const c = target[i - 1] === heard[j - 1] ? 0 : 1;
    dp[i][j] = Math.min(dp[i - 1][j - 1] + c, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
  }
  const res = new Array(n); i = n; j = m;
  while (i > 0) {
    if (j > 0 && target[i - 1] === heard[j - 1] && dp[i][j] === dp[i - 1][j - 1]) { res[i - 1] = { ok: true }; i--; j--; }
    else if (j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) { res[i - 1] = { ok: false, heard: heard[j - 1] }; i--; j--; }
    else if (dp[i][j] === dp[i - 1][j] + 1) { res[i - 1] = { ok: false, heard: "" }; i--; }
    else { j--; }
  }
  return res;
}
// Same, for speech still in progress: the heard words are matched against the start of the
// sentence only, so words not read yet are "pending" instead of pulling the alignment apart.
function alignPrefix(target, heard) {
  const n = target.length, m = heard.length, dp = [];
  let i, j;
  for (i = 0; i <= n; i++) { dp.push(new Array(m + 1)); dp[i][0] = i; }
  for (j = 0; j <= m; j++) dp[0][j] = j;
  for (i = 1; i <= n; i++) for (j = 1; j <= m; j++) {
    const c = target[i - 1] === heard[j - 1] ? 0 : 1;
    dp[i][j] = Math.min(dp[i - 1][j - 1] + c, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
  }
  let end = 0;
  for (i = 1; i <= n; i++) if (dp[i][m] <= dp[end][m]) end = i;
  const res = new Array(n);
  for (i = end; i < n; i++) res[i] = { ok: false, heard: "", pending: true };
  i = end; j = m;
  while (i > 0) {
    if (j > 0 && target[i - 1] === heard[j - 1] && dp[i][j] === dp[i - 1][j - 1]) { res[i - 1] = { ok: true }; i--; j--; }
    else if (j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) { res[i - 1] = { ok: false, heard: heard[j - 1] }; i--; j--; }
    else if (dp[i][j] === dp[i - 1][j] + 1) { res[i - 1] = { ok: false, heard: "" }; i--; }
    else { j--; }
  }
  return res;
}

// ---------- state ----------
let dict = null, sample = null;
let lesson = null, lessonIsToday = false;
let session = { date: TODAY, reads: {}, missed: [], drills: {}, speak: "" };
let allSessions = [], troub = {}, vocabDocs = {};
let rec = null; // active recording, see startRec()
function save(col, id, body) { store.set(col, id, body).catch((e) => status("Could not save: " + ((e && e.code) || "error") + ". Your results stay on screen.")); }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Status note: one message at a time, with an optional action link and a close button.
// Messages with a key stay hidden once the learner closes them.
let statusKey = "";
function status(msg, opts = {}) {
  const box = $("status"), action = $("status-action");
  if (!msg) { box.hidden = true; statusKey = ""; return; }
  if (opts.key && getSetting("dismissed", {})[opts.key]) return;
  statusKey = opts.key || "";
  $("status-text").textContent = msg;
  action.hidden = !opts.action;
  if (opts.action) { action.textContent = opts.action.label; action.href = opts.action.href; }
  box.hidden = false;
}
function wireStatus() {
  $("status-close").onclick = () => {
    if (statusKey) setSettings({ dismissed: Object.assign({}, getSetting("dismissed", {}), { [statusKey]: true }) });
    status("");
  };
}
function aiError(e, what) {
  const code = (e && e.code) || "error";
  const why = {
    no_key: "Add your Anthropic API key in Settings.",
    bad_key: "The API key was rejected. Check it in Settings.",
    no_access: "This API key cannot use the chosen model. Pick another model in Settings.",
    model_not_found: "The chosen model is not available for this key. Pick another model in Settings.",
    rate_limited: "Too many requests right now. Wait a minute and try again.",
    offline: "No connection to Claude. Check your internet connection.",
    refusal: "Claude declined this request. Try again.",
    invalid_json: "Claude's answer could not be read. Try again.",
  }[code] || "Error " + code + ". Try again in a moment.";
  return what + " could not be created. " + why;
}

// ---------- icons ----------
const ICONS = {
  mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  speaker: '<path d="M4 10v4h4l5 4V6L8 10H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  play: '<path d="M8 5.5v13l11-6.5-11-6.5Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  prev: '<path d="m15 6-6 6 6 6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  dots: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
};
function icon(name) { return '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>"; }
function setButton(btn, name, label) { btn.innerHTML = icon(name) + (label ? "<span>" + label + "</span>" : ""); }

// ---------- audio out ----------
function say(text, rate) { return speak(text, rate || 1); }
function stopAudio() { stopSpeech(); }

// ---------- microphone ----------
function micHelp() {
  if (PLATFORM === "web") return "Reading aloud needs speech recognition: open the app in Google Chrome, or use the Mac app.";
  return "Speech recognition is not available on this device. Check that dictation is enabled in the system settings.";
}
// One recording at a time. o = { key, btn, live, done(text, how), target?, onLive?(text), onEmpty?(),
// onRecState?(state) with state "rec" | "closing" | "idle" }.
// With a target sentence the take stops by itself: right after its last word is heard,
// or after a short silence once the learner has started speaking.
function startRec(o) {
  if (!dict) { status(micHelp(), { key: "nomic" }); return false; }
  if (rec) return false; // the previous take is still closing
  stopAudio();
  rec = Object.assign({ buf: "", interim: "", how: "auto", spoke: false, stopping: false, restarts: 0, okSet: new Set(), bestOk: -1, bestText: "", timers: {}, floor: null, lastVoice: 0, levels: false, voice: false }, o);
  rec.deadline = Date.now() + (10000 + (o.target ? o.target.length : 0) * 1200) * pauseFactor();
  if (o.onRecState) o.onRecState("rec");
  else { rec.label = o.btn.innerHTML; o.btn.textContent = "Stop"; o.btn.classList.add("rec"); }
  if (o.live) { o.live.textContent = "Listening…"; o.live.classList.remove("idle"); o.live.classList.add("listening"); }
  if (o.target) {
    rec.timers.quiet = setTimeout(() => stopWhenQuiet("quiet"), 10000 * pauseFactor()); // nothing said at all
    rec.timers.max = setTimeout(() => stopRec("auto", "max time for this sentence"), (10000 + o.target.length * 1200) * pauseFactor());
  }
  diag("app start take", o.key, o.target ? o.target.join(" ") : "", { pause: getSetting("pause", "long"), expect: getSetting("expectWords", true), handsFree: prefs.handsFree, listenFirst: prefs.listenFirst });
  dict.start({ language: "en", phrases: o.phrases }).catch((e) => finishRec(e && e.code));
  return true;
}
function stopRec(how, why) {
  if (!rec) return;
  rec.how = how; rec.stopping = true;
  diag("app stop take", how, why || "", "heard so far:", heardSoFar());
  // While Apple sends its final text (up to a few seconds) the button says so instead of "Stop".
  if (how !== "cancel") {
    if (rec.onRecState) rec.onRecState("closing");
    else { rec.btn.textContent = "Checking…"; rec.btn.classList.add("closing"); }
  }
  Object.values(rec.timers).forEach(clearTimeout);
  dict.stop().catch(() => {});
}
// How long the microphone waits in silence before closing the take (Settings → Reading).
const PAUSES = { short: 0.6, normal: 1, long: 1.6 };
function pauseFactor() { return PAUSES[getSetting("pause", "long")] || 1; }
// The sentence and its words, so Apple's recognizer expects them (Settings → Reading).
function expectedPhrases(text) {
  if (!getSetting("expectWords", true)) return [];
  const clean = (w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  const list = [String(text).replace(/[“”"]/g, "").trim()];
  String(text).split(/[\s—–/]+/).map(clean).forEach((w) => { if (w && list.indexOf(w) < 0) list.push(w); });
  return list;
}
function heardSoFar() { return rec ? (rec.buf + " " + rec.interim).trim() : ""; }
function onHeard() {
  if (!rec) return;
  const text = heardSoFar();
  if (rec.onLive) rec.onLive(text);
  else if (rec.live) rec.live.textContent = text || "Listening…";
  if (rec.target && text) {
    let okCount = 0;
    alignPrefix(rec.target, words(text)).forEach((r, i) => { if (r.ok) { rec.okSet.add(i); okCount++; } });
    if (okCount >= rec.bestOk) { rec.bestOk = okCount; rec.bestText = text; }
  }
  if (!rec.target || !text || rec.stopping) return; // results that arrive while closing only update the text
  if (!rec.spoke) { rec.spoke = true; clearTimeout(rec.timers.quiet); }
  const heard = words(text), res = alignPrefix(rec.target, heard);
  // Apple re-ranks its text when the take ends and sometimes drops or changes a word it had
  // already recognized (most often the last one). Keep every word recognized at any moment.
  const last = res[res.length - 1];
  const coverage = heard.length / rec.target.length;
  // "Finished" only when the sentence's last word is also the last word heard.
  const finished = last && last.ok && heard[heard.length - 1] === rec.target[rec.target.length - 1] && coverage >= 0.75;
  clearTimeout(rec.timers.silence);
  const wait = (finished ? 1000 : coverage >= 0.5 ? 2400 : 3400) * pauseFactor();
  diag("app heard", text, { finished, coverage: +coverage.toFixed(2), wait });
  rec.timers.silence = setTimeout(() => stopWhenQuiet("silence"), wait);
}
// Apple's text can arrive seconds late (its recognizer runs on Apple's servers), so a pause
// in the text is not proof of silence. In the Mac app the microphone level decides: the take
// closes only once the learner's voice has really been quiet for a moment.
const VOICE_ABOVE_NOISE = 0.15; // level 0..1 is -50..0 dBFS, so 0.15 is 7.5 dB over the room
function onLevel(level) {
  if (!rec || rec.stopping) return;
  rec.levels = true;
  if (rec.floor == null || level < rec.floor) rec.floor = level;
  else rec.floor += (level - rec.floor) * 0.002; // the room's noise, rising slowly if it gets louder
  const voice = level > rec.floor + VOICE_ABOVE_NOISE;
  if (voice) rec.lastVoice = Date.now();
  // The button's ring follows the voice, so the learner can see the microphone hearing them.
  rec.btn.classList.add("metered");
  rec.btn.style.setProperty("--lvl", Math.max(0, Math.min(1, (level - rec.floor) / 0.35)).toFixed(2));
  if (voice && rec.live && !heardSoFar() && !rec.hearing) { rec.hearing = true; rec.live.textContent = "Hearing you…"; }
  if (voice !== rec.voice) { rec.voice = voice; diag("app voice", voice ? "on" : "off", { level: +level.toFixed(2), floor: +rec.floor.toFixed(2) }); }
}
function stopWhenQuiet(why) {
  if (!rec || rec.stopping) return;
  const hold = 1000 * pauseFactor(), since = Date.now() - rec.lastVoice;
  if (rec.levels && since < hold) {
    diag("app keeps listening: voice heard " + since + " ms ago", why);
    rec.timers[why] = setTimeout(() => stopWhenQuiet(why), hold - since + 100);
    return;
  }
  stopRec("auto", why + " timer, voice quiet for " + since + " ms" + (rec.levels ? "" : " (no mic level)"));
}
function finishRec(reason) {
  if (!rec) return;
  // The recognizer sometimes closes by itself during a pause (Apple's and Chrome's do).
  // If the app did not ask it to stop, reopen it and keep what was already heard.
  if (rec.target && !rec.stopping && reason !== "not_granted" && reason !== "no_microphone"
      && rec.restarts < 8 && Date.now() < rec.deadline) {
    const r = rec;
    r.buf = (r.buf + " " + r.interim).trim(); r.interim = ""; r.restarts++;
    diag("app RESTART recognizer (engine closed by itself)", { reason, buf: r.buf });
    const reopen = (tries) => dict.start({ language: "en", phrases: r.phrases }).catch((e) => {
      diag("app restart failed", { code: e && e.code, tries });
      if (rec !== r) return;
      if (tries < 3 && !r.stopping) { setTimeout(() => { if (rec === r && !r.stopping) reopen(tries + 1); }, 400); return; }
      r.stopping = true; finishRec(e && e.code);
    });
    reopen(1);
    return;
  }
  const r = rec; rec = null;
  diag("app take closed", { reason: reason || "", how: r.how, stopping: r.stopping, restarts: r.restarts });
  Object.values(r.timers).forEach(clearTimeout);
  r.btn.style.removeProperty("--lvl"); r.btn.classList.remove("metered");
  if (r.onRecState) r.onRecState("idle");
  else { r.btn.innerHTML = r.label; r.btn.classList.remove("rec", "closing"); }
  if (r.live) { r.live.textContent = ""; r.live.classList.remove("listening"); }
  if (r.how === "cancel") return;
  const text = (r.buf + " " + r.interim).trim();
  if (!text) {
    if (reason === "not_granted") status("The microphone or speech recognition permission is off. Turn it on for Daily English in the system settings (or Chrome's site settings) and try again.");
    else if (reason === "no_microphone") status("No microphone was found.");
    else if (reason === "network") status("Speech recognition in Chrome needs an internet connection.");
    else if (reason === "unavailable") status("Speech recognition is not available right now.");
    else if (r.live) r.live.textContent = "Nothing was heard. Try again a little closer to the microphone.";
    if (r.onEmpty) r.onEmpty();
    return;
  }
  status("");
  // Show and grade Apple's most complete version of the take when the final text lost words.
  let shown = text;
  if (r.target && r.bestText) {
    const finalOk = align(r.target, words(text)).filter((x) => x.ok).length;
    if (r.bestOk > finalOk) shown = r.bestText;
  }
  diag("app grade", shown, shown !== text ? "(final was: " + text + ")" : "");
  r.done(shown, r.how, Array.from(r.okSet));
}
// Simple start/stop toggle used by the word rows and Speak freely.
function toggleRec(o) {
  if (rec) { if (rec.key === o.key) stopRec("manual"); return; }
  endFlow();
  startRec(o);
}
function wireDictation() {
  dict.onFinal((e) => { if (rec) { rec.buf = (rec.buf + " " + e.text).trim(); rec.interim = ""; onHeard(); } });
  dict.onPartial((e) => {
    if (!rec) return;
    rec.interim = e.text || ""; onHeard();
  });
  dict.onLevel((e) => onLevel(e.level));
  dict.onState((e) => { if (e.state === "idle") finishRec(e.reason); });
}

// ---------- today: the reader ----------
// One sentence is "active". Read records it; the take stops by itself and the next
// sentence becomes active. Hands-free keeps going; Listen first plays the model before each take.
let active = 0;
let flow = null, flowSeq = 0; // automated run: { id, kind: "read" | "play" }
const prefs = { handsFree: true, listenFirst: false, slow: false };
function rate() { return prefs.slow ? 0.75 : 1; }
function items() { return $("sentences").children; }
function count() { return (lesson && lesson.sentences || []).length; }

function vocabSet() {
  const s = {}; (lesson.vocab || []).forEach((v) => { words(v.inStory || v.word).forEach((w) => { if (w.length > 3) s[w] = 1; }); }); return s;
}
function renderLesson() {
  endFlow();
  $("lesson-title").textContent = lesson.title || "Today's story";
  $("lesson-kicker").textContent = (lessonIsToday ? "Today's story" : (lesson.source === "bundled" ? "Starter story" : "Latest story, " + lesson.date)) + (lesson.level ? " · " + lesson.level : "");
  const box = $("sentences"); box.textContent = "";
  const vs = vocabSet();
  (lesson.sentences || []).forEach((text, idx) => {
    const li = el("li", "sent"); li.dataset.idx = idx;
    const p = el("p", "sent-text");
    String(text).split(/\s+/).forEach((raw, k) => {
      if (k) p.appendChild(document.createTextNode(" "));
      const sp = el("span", "tok", raw); sp.dataset.n = words(raw).join(" ");
      if (words(raw).some((w) => vs[w])) sp.classList.add("vocab");
      p.appendChild(sp);
    });
    const score = el("span", "chip score"); score.hidden = true; p.appendChild(score);
    const live = el("div", "sent-live"); live.setAttribute("aria-live", "polite");
    const actions = el("div", "sent-actions"); actions.hidden = true;
    li.append(p, live, actions);
    li._p = p; li._score = score; li._live = live; li._actions = actions;
    box.appendChild(li);
    const prev = session.reads[idx];
    if (prev) paintSentence(li, text, prev.heard, prev.ok);
  });
  const firstUnread = (lesson.sentences || []).findIndex((_, i) => !session.reads[i]);
  select(firstUnread < 0 ? 0 : firstUnread, { scroll: false });
  $("speak-prompt").textContent = lesson.speak || "Retell today's story in your own words.";
  $("speak-text").textContent = session.speak || "";
  $("speak-feedback").hidden = true;
  renderFocus(); renderVocab(); renderDrills(); renderFix(); updateAcc(); updateAIButtons();
}
function select(idx, opts = {}) {
  const n = count(); if (!n) return;
  active = Math.max(0, Math.min(n - 1, idx));
  Array.from(items()).forEach((li, i) => li.classList.toggle("active", i === active));
  const done = Object.keys(session.reads).length, acc = accuracy(session);
  $("reader-pos").textContent = done === n
    ? "Story complete · " + acc + "% understood"
    : "Sentence " + (active + 1) + " of " + n + (done ? " · " + done + " read" : "");
  $("reader-fill").style.width = Math.round(100 * done / n) + "%";
  $("r-prev").disabled = active === 0;
  $("r-next").disabled = active === n - 1;
  const li = items()[active];
  if (li && !session.reads[active] && !(rec && rec.key === "s" + active) && !li._live.classList.contains("listening")) setIdleHint(li);
  if (opts.scroll !== false && li) ensureVisible(li);
}
// Keep the active sentence in the free space between the sticky top bar and the reading bar.
function ensureVisible(li) {
  const r = li.getBoundingClientRect();
  const top = document.querySelector(".topbar").getBoundingClientRect().bottom;
  const bottom = Math.min(window.innerHeight, $("reader").getBoundingClientRect().top);
  if (r.top >= top + 8 && r.bottom <= bottom - 8) return;
  const y = window.scrollY + r.top + r.height / 2 - (top + bottom) / 2;
  window.scrollTo({ top: Math.max(0, y), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
function setFocusing(on) { $("sentences").classList.toggle("focusing", on); }
function setReadButton(state) {
  const b = $("r-read");
  b.classList.toggle("rec", state === "rec");
  b.classList.toggle("wait", state === "model");
  b.classList.toggle("closing", state === "closing");
  if (state === "rec") setButton(b, "stop", "Stop");
  else if (state === "model") setButton(b, "speaker", "Listen…");
  else if (state === "closing") setButton(b, "dots", "Checking…");
  else setButton(b, "mic", "Read");
}
// Under the active sentence, before it is read: what to do next.
const HAS_KEYS = matchMedia("(hover: hover) and (pointer: fine)").matches;
function setIdleHint(li) {
  li._live.textContent = HAS_KEYS ? "Press Read (or Space) and read this sentence aloud." : "Press Read and read this sentence aloud.";
  li._live.classList.add("idle"); li._live.classList.remove("listening");
}
function setPlayButton(on) { setButton($("play-story"), on ? "pause" : "play", on ? "Stop" : "Play story"); }
function flowAlive(id) { return flow && flow.id === id; }
function endFlow() {
  if (rec && rec.key && rec.key.charAt(0) === "s") stopRec("cancel");
  if (flow) stopAudio();
  flow = null;
  setFocusing(false); setPlayButton(false);
  if (!rec) setReadButton("idle");
}

async function readFrom(idx, id) {
  if (!dict) { status(micHelp(), { key: "nomic" }); return; }
  if (id == null) { endFlow(); id = ++flowSeq; flow = { id, kind: "read" }; setFocusing(true); }
  select(idx);
  const text = lesson.sentences[active];
  if (prefs.listenFirst) {
    setReadButton("model");
    const how = await say(text, rate());
    if (!flowAlive(id) || how === "cancelled") return;
    await delay(250); // let the speaker go quiet before the mic opens
    if (!flowAlive(id)) return;
  }
  const li = items()[active], target = words(text), at = active;
  li._actions.hidden = true;
  startRec({
    key: "s" + at, btn: $("r-read"), live: li._live, target, phrases: expectedPhrases(text),
    onRecState: (state) => setReadButton(state),
    onLive: (heard) => liveSentence(li, target, heard),
    done: (heard, how, okIdx) => { gradeSentence(at, heard, okIdx); afterSentence(at, id, how); },
    onEmpty: () => { clearLive(li); if (session.reads[at]) paintSentence(li, text, session.reads[at].heard, session.reads[at].ok); if (flowAlive(id)) endFlow(); },
  });
}
function afterSentence(idx, id, how) {
  const last = idx >= count() - 1;
  select(last ? idx : idx + 1, { scroll: !last });
  if (!flowAlive(id)) return;
  if (how !== "auto" || !prefs.handsFree || last) { endFlow(); return; }
  setTimeout(() => { if (flowAlive(id)) readFrom(idx + 1, id); }, 650);
}
function readToggle() {
  if (rec && rec.key.charAt(0) === "s") { stopRec("manual"); return; }
  if (rec) stopRec("cancel");
  if (flow) { endFlow(); return; }
  readFrom(active);
}
async function playStory() {
  if (flow && flow.kind === "play") { endFlow(); return; }
  endFlow();
  const id = ++flowSeq; flow = { id, kind: "play" };
  setFocusing(true); setPlayButton(true);
  for (let i = active; i < count(); i++) {
    select(i);
    const how = await say(lesson.sentences[i], rate());
    if (!flowAlive(id) || how !== "end") break;
    await delay(220);
    if (!flowAlive(id)) break;
  }
  if (flowAlive(id)) endFlow();
}
function go(step) { if (rec) stopRec("cancel"); endFlow(); select(active + step); }

function tokensOf(li) { return Array.from(li._p.querySelectorAll(".tok")); }
// Karaoke feedback while speaking: words already heard turn green, the next one is underlined.
function liveSentence(li, target, heardText) {
  const res = alignPrefix(target, words(heardText));
  let k = 0, lastOk = -1;
  const toks = tokensOf(li);
  toks.forEach((sp, ti) => {
    const parts = sp.dataset.n ? sp.dataset.n.split(" ") : [];
    let ok = parts.length > 0;
    parts.forEach(() => { const r = res[k++]; if (!(r && r.ok)) ok = false; });
    sp.classList.remove("ok", "miss");
    sp.classList.toggle("live-ok", ok);
    if (ok) lastOk = ti;
  });
  toks.forEach((sp, ti) => sp.classList.toggle("next", ti === lastOk + 1));
  li._live.textContent = heardText || "Listening…";
}
function clearLive(li) { tokensOf(li).forEach((sp) => sp.classList.remove("live-ok", "next")); }
// A word counts as understood if the final text has it, or if it was recognized at some
// moment during the take (okIdx: positions in the sentence).
function paintSentence(li, text, heardText, okIdx) {
  const target = words(text), res = align(target, words(heardText)), missed = [];
  const seen = new Set(okIdx || []);
  let k = 0, hit = 0;
  tokensOf(li).forEach((sp) => {
    sp.classList.remove("live-ok", "next");
    const parts = sp.dataset.n ? sp.dataset.n.split(" ") : []; if (!parts.length) return;
    let ok = true;
    parts.forEach((w) => { const at = k++, r = res[at]; if ((r && r.ok) || seen.has(at)) hit++; else { ok = false; missed.push({ word: w, heard: r ? r.heard : "" }); } });
    sp.classList.remove("ok", "miss"); sp.classList.add(ok ? "ok" : "miss");
  });
  const pct = target.length ? Math.floor(100 * hit / target.length) : 0;
  li._score.hidden = false; li._score.textContent = pct + "%";
  li._score.className = "chip score " + grade(pct);
  li._live.textContent = ""; li._live.classList.remove("idle", "listening"); li._live.append("Heard: ", el("b", "", heardText));
  const acts = li._actions; acts.textContent = "";
  const again = el("button", "pill quiet"); setButton(again, "mic", "Read again");
  again.onclick = (e) => { e.stopPropagation(); if (rec) return; const i = +li.dataset.idx; endFlow(); readFrom(i); };
  acts.appendChild(again);
  if (missed.length) acts.appendChild(el("span", "hint", "Tap a red word to hear it."));
  acts.hidden = false;
  return { hit, total: target.length, missed };
}
function gradeSentence(idx, heardText, okIdx) {
  const li = items()[idx], text = lesson.sentences[idx];
  const g = paintSentence(li, text, heardText, okIdx);
  session.reads[idx] = { heard: heardText, hit: g.hit, total: g.total, ok: okIdx || [] };
  const touched = [];
  g.missed.forEach((m) => {
    if (m.word.length < 3) return;
    const t = troub[m.word] || (troub[m.word] = { word: m.word, misses: 0, hits: 0 });
    t.misses++; t.last = TODAY; t.heardAs = m.heard || ""; touched.push(m.word);
    if (session.missed.indexOf(m.word) < 0) session.missed.push(m.word);
  });
  const wasDone = !$("story-done").hidden;
  saveSession(); touched.forEach(saveWord);
  renderFix(); updateAcc(); renderProgress();
  // Finishing the story: bring the summary into view above the reading bar.
  if (!wasDone && !$("story-done").hidden) setTimeout(() => ensureVisible($("story-done")), 350);
}
function wireReader() {
  prefs.handsFree = getSetting("handsFree", true);
  prefs.listenFirst = getSetting("listenFirst", false);
  prefs.slow = getSetting("slow", false);
  [["opt-handsfree", "handsFree"], ["opt-listenfirst", "listenFirst"], ["opt-slow", "slow"]].forEach(([id, key]) => {
    const box = $(id); box.checked = prefs[key];
    box.onchange = () => { prefs[key] = box.checked; setSettings({ [key]: box.checked }); };
  });
  setButton($("r-prev"), "prev"); setButton($("r-next"), "next");
  setButton($("r-listen"), "speaker", "Listen");
  setReadButton("idle"); setPlayButton(false);
  $("r-prev").onclick = () => go(-1);
  $("r-next").onclick = () => go(1);
  $("r-listen").onclick = () => { if (rec) stopRec("cancel"); endFlow(); say(lesson.sentences[active], rate()); };
  $("r-read").onclick = readToggle;
  $("play-story").onclick = playStory;
  // Tap a sentence to make it active; tap a word in the active sentence to hear it.
  $("sentences").onclick = (e) => {
    const li = e.target.closest(".sent"); if (!li) return;
    const idx = +li.dataset.idx;
    if (idx !== active) { go(idx - active); return; }
    const tok = e.target.closest(".tok");
    if (tok && !rec) say(tok.textContent.replace(/[^\w'’-]+/g, " ").trim(), 0.8);
  };
  document.addEventListener("keydown", (e) => {
    if (!$("view-today").classList.contains("on") || !lesson) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest("input, textarea, select, button, a, [contenteditable]")) return;
    if (e.code === "Space") { e.preventDefault(); readToggle(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    else if (e.key === "l" || e.key === "L") { e.preventDefault(); $("r-listen").click(); }
  });
}
function accuracy(s) { let h = 0, t = 0; Object.keys(s.reads || {}).forEach((k) => { h += s.reads[k].hit; t += s.reads[k].total; }); return t ? Math.floor(100 * h / t) : null; } // floor: 100% only when every word was understood
function updateAcc() {
  const a = accuracy(session), n = Object.keys(session.reads).length, c = $("acc-chip");
  renderDone(); renderPlan();
  if (a == null) { c.textContent = "Not read yet"; c.className = "chip"; return; }
  c.textContent = a + "% understood · " + n + "/" + (lesson.sentences || []).length + " sentences";
  c.className = "chip " + (a >= 90 ? "good" : a >= 70 ? "mark" : "miss");
}
function grade(pct) { return pct >= 90 ? "good" : pct >= 70 ? "mark" : "miss"; }
// Shown under the story once every sentence has a result.
function renderDone() {
  const n = count(), read = Object.keys(session.reads).length, box = $("story-done");
  if (!n || read < n) { box.hidden = true; return; }
  const acc = accuracy(session), missed = session.missed.filter((w) => troub[w]).length;
  const sc = $("done-score"); sc.textContent = acc + "%"; sc.className = "done-score " + grade(acc);
  $("done-title").textContent = acc >= 90 ? "Great reading" : acc >= 70 ? "Good work" : "Story complete";
  $("done-text").textContent = missed
    ? (missed === 1 ? "1 word was not understood. Practice it" : missed + " words were not understood. Practice them") + ", then read the story again."
    : "Every word was understood. Try the exercises or speak freely next.";
  $("done-fix").hidden = !missed;
  box.hidden = false;
}
// Today's plan: the four parts of the daily practice, each with its state; a tap jumps there.
function renderPlan() {
  if (!lesson) return;
  const n = count(), read = Object.keys(session.reads).length, storyDone = n > 0 && read >= n;
  const missed = session.missed.filter((w) => troub[w]);
  const toFix = missed.filter((w) => !(troub[w].hits > 0)).length;
  const ds = lesson.drills || [], answered = ds.filter((d, i) => session.drills[i] != null).length;
  const steps = [
    { label: "Read the story", target: "story-card", done: storyDone, detail: read + "/" + n },
    { label: "Fix words", target: "fix-card", done: storyDone && toFix === 0, detail: missed.length ? (toFix ? toFix + " left" : "All said well") : (storyDone ? "None to fix" : "After reading") },
    { label: "Exercises", target: "drill-card", done: ds.length > 0 && answered === ds.length, detail: answered + "/" + ds.length },
    { label: "Speak freely", target: "speak-card", done: !!session.speak, detail: session.speak ? "Done" : "About a minute" },
  ];
  const box = $("plan"); box.textContent = "";
  steps.forEach((st, i) => {
    const a = el("a", "step" + (st.done ? " done" : "")); a.href = "#today";
    a.append(el("span", "step-n", st.done ? "✓" : String(i + 1)), el("span", "step-l", st.label), el("span", "step-d", st.detail));
    a.setAttribute("aria-label", st.label + ": " + (st.done ? "done" : st.detail));
    a.onclick = (e) => { e.preventDefault(); goToCard(st.target); };
    box.appendChild(a);
  });
}
function goToCard(id) {
  const c = $(id);
  c.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  c.focus({ preventScroll: true });
}
function saveSession() {
  if (!lesson) return;
  const body = { date: TODAY, lesson: lesson.date, title: lesson.title || "", reads: session.reads, missed: session.missed, drills: session.drills, speak: session.speak || "", accuracy: accuracy(session), updatedAt: new Date().toISOString() };
  let found = false; allSessions = allSessions.map((s) => { if (s.date === TODAY) { found = true; return body; } return s; }); if (!found) allSessions.push(body);
  save("sessions", TODAY, body);
}
function saveWord(w) { if (!troub[w]) return; save("words", docId(w), troub[w]); }

// ---------- word rows (fix list + difficult words) ----------
function wordRow(t) {
  const row = el("div", "wordrow"), head = el("div", "wordhead");
  head.appendChild(el("span", "vword", t.word));
  if (t.coach && t.coach.ipa) head.appendChild(el("span", "ipa", t.coach.ipa));
  if (t.heardAs) head.appendChild(el("span", "chip miss", "heard as “" + t.heardAs + "”"));
  const b1 = el("button", "pill"); setButton(b1, "speaker", "Listen"); b1.onclick = () => say(t.word, 0.8);
  const b2 = el("button", "primary pill"); setButton(b2, "mic", "Say it");
  const live = el("div", "live");
  b2.onclick = () => {
    toggleRec({ key: "w" + t.word, btn: b2, live, done: (text) => {
      const ok = words(text).indexOf(t.word) >= 0;
      if (ok) { t.hits = (t.hits || 0) + 1; saveWord(t.word); }
      live.textContent = ok ? "Understood: “" + t.word + "”. Well done." : "Heard “" + text + "”. Listen again and retry.";
      renderProgress();
    } });
  };
  head.append(b1, b2); row.append(head, live);
  const c = t.coach;
  if (c) {
    if (c.say) row.appendChild(el("p", "small", "Suena como: " + c.say));
    if (c.tip) row.appendChild(el("p", "small", c.tip));
    if (c.pair) { const pr = el("div", "row small"); pr.appendChild(el("span", "hint", "Compare:")); String(c.pair).split(/\s*\/\s*/).forEach((w) => { const b = el("button", "", w); b.onclick = () => say(w, 0.8); pr.appendChild(b); }); row.appendChild(pr); }
    if (c.examples && c.examples.length) { const ul = el("ul", "plain"); c.examples.forEach((x) => { const li = el("li", "ex", x); li.style.cursor = "pointer"; li.title = "Tap to listen"; li.onclick = () => say(x, 0.9); ul.appendChild(li); }); row.appendChild(ul); }
  }
  return row;
}
function renderFix() {
  const list = $("fix-list"); list.textContent = "";
  const ws = session.missed.filter((w) => troub[w]);
  $("fix-empty").hidden = ws.length > 0;
  ws.forEach((w) => list.appendChild(wordRow(troub[w])));
  const need = ws.filter((w) => !troub[w].coach);
  $("coach-btn").disabled = !sample || need.length === 0;
  $("coach-btn").textContent = need.length ? "Coach me on these words" : (ws.length ? "Coaching ready" : "Coach me on these words");
  $("coach-btn").title = sample ? "" : "Add your API key in Settings";
  renderPlan();
}
function coach() {
  const need = session.missed.filter((w) => troub[w] && !troub[w].coach).slice(0, 15);
  if (!sample || !need.length) return;
  const btn = $("coach-btn"); btn.disabled = true; btn.textContent = "Thinking…";
  const info = need.map((w) => w + (troub[w].heardAs ? " (speech recognition heard: " + troub[w].heardAs + ")" : "")).join("; ");
  const prompt = "You are a native English pronunciation coach for a Spanish-speaking adult (Latin American Spanish) working toward C1/C2 speaking. " +
    "The learner read a text aloud and speech recognition did not understand these words: " + info + ".\n" +
    "Reply with only a JSON object whose keys are exactly those words (lowercase). Each value is an object with: " +
    '"ipa" (General American IPA between slashes), ' +
    '"say" (a respelling a Spanish speaker can read aloud, stressed syllable in CAPITALS, e.g. "i-LU-siv"), ' +
    '"tip" (2 short sentences IN SPANISH: the mistake Spanish speakers usually make with this word and what to do with mouth, stress or rhythm to fix it; use what was heard as a clue), ' +
    '"pair" (two English words separated by " / " that contrast the difficult sound, e.g. "ship / sheep"), ' +
    '"examples" (array of 3 natural English sentences, C1 level, each using the word).\n' +
    'Example: {"focus":{"ipa":"/ˈfoʊkəs/","say":"FOU-kes","tip":"...","pair":"folk / fork","examples":["...","...","..."]}}';
  sample.askJSON(prompt, { effort: "low" }).then((out) => {
    need.forEach((w) => { const c = out && out[w]; if (c && typeof c === "object") { troub[w].coach = { ipa: String(c.ipa || ""), say: String(c.say || ""), tip: String(c.tip || ""), pair: String(c.pair || ""), examples: Array.isArray(c.examples) ? c.examples.slice(0, 3).map(String) : [] }; saveWord(w); } });
    renderFix(); renderHard(); renderProgress();
  }).catch((e) => {
    btn.textContent = "Coach me on these words"; btn.disabled = false;
    status(aiError(e, "The coaching"));
  });
}

// ---------- focus, vocab, drills ----------
function renderFocus() {
  const f = lesson.focus; $("focus-card").hidden = !f; if (!f) return;
  $("focus-title").textContent = f.title || ""; $("focus-tip").textContent = f.tip || "";
  const g = $("focus-items"); g.textContent = "";
  (f.items || []).forEach((it) => { const c = el("div", "vcard"); c.appendChild(el("div", "vword", it.text)); if (it.note) c.appendChild(el("div", "ipa", it.note)); const b = el("button", "pill"); setButton(b, "speaker", "Listen"); b.onclick = () => say(it.text, 0.8); c.appendChild(b); g.appendChild(c); });
}
function vocabCard(v, withGrade) {
  const c = el("div", "vcard");
  c.appendChild(el("div", "vword", v.word));
  const meta = [v.ipa, v.say].filter(Boolean).join("  ·  "); if (meta) c.appendChild(el("div", "ipa", meta));
  const body = el("div"); body.style.display = "flex"; body.style.flexDirection = "column"; body.style.gap = "6px";
  if (v.level || v.pos) body.appendChild(el("div", "row", "")).appendChild(el("span", "chip mark", [v.level, v.pos].filter(Boolean).join(" · ")));
  if (v.meaning) body.appendChild(el("div", "small", v.meaning));
  if (v.es) body.appendChild(el("div", "small hint", "ES: " + v.es));
  if (v.example) body.appendChild(el("div", "ex small", v.example));
  const ctl = el("div", "row");
  const b = el("button", "pill"); setButton(b, "speaker", "Listen"); b.onclick = () => say(v.word + ". " + (v.example || ""), 0.9); ctl.appendChild(b);
  if (withGrade) {
    body.hidden = true;
    const show = el("button", "primary", "Show meaning"); ctl.appendChild(show);
    show.onclick = () => {
      body.hidden = false; show.remove();
      const again = el("button", "", "Again tomorrow"), got = el("button", "primary", "I knew it");
      again.onclick = () => gradeVocab(v, false); got.onclick = () => gradeVocab(v, true);
      ctl.append(again, got);
    };
  }
  c.append(body, ctl); return c;
}
function renderVocab() {
  const g = $("vocab"); g.textContent = ""; (lesson.vocab || []).forEach((v) => g.appendChild(vocabCard(v, false)));
}
function seedVocab() {
  if (!lessonIsToday && lesson.source !== "bundled") return;
  (lesson.vocab || []).forEach((v) => {
    const id = docId(v.word); if (vocabDocs[id]) return;
    const body = { word: String(v.word), ipa: String(v.ipa || ""), say: String(v.say || ""), meaning: String(v.meaning || ""), es: String(v.es || ""), example: String(v.example || ""), level: String(v.level || ""), pos: String(v.pos || ""), added: TODAY, due: addDays(TODAY, 1), step: 0 };
    vocabDocs[id] = body; save("vocab", id, body);
  });
}
function gradeVocab(v, knew) {
  const id = docId(v.word); let d = vocabDocs[id]; if (!d) return;
  const step = knew ? (d.step || 0) + 1 : 0;
  d = vocabDocs[id] = Object.assign({}, d, { step, due: addDays(TODAY, knew ? INTERVALS[Math.min(step, INTERVALS.length - 1)] : 1), lastReview: TODAY });
  save("vocab", id, d);
  renderDue(); renderProgress();
}
function renderDrills() {
  const box = $("drills"); box.textContent = "";
  (lesson.drills || []).forEach((d, i) => {
    const row = el("div", "drill"); row.appendChild(el("div", "q", (i + 1) + ". " + d.prompt));
    const opts = el("div", "row"), note = el("div", "small hint");
    (d.options || []).forEach((o) => {
      const b = el("button", "opt", o);
      b.onclick = () => { session.drills[i] = o; saveSession(); paint(); updateDrillChip(); };
      opts.appendChild(b);
    });
    function paint() {
      const picked = session.drills[i]; if (picked == null) return;
      Array.from(opts.children).forEach((b) => { b.disabled = true; if (b.textContent === d.answer) b.classList.add("right"); else if (b.textContent === picked) b.classList.add("wrong"); });
      note.textContent = (picked === d.answer ? "Correct. " : "Not quite. ") + (d.why || "");
    }
    row.append(opts, note); box.appendChild(row); paint();
  });
  updateDrillChip();
}
function updateDrillChip() {
  const ds = lesson.drills || []; let done = 0, ok = 0;
  ds.forEach((d, i) => { if (session.drills[i] != null) { done++; if (session.drills[i] === d.answer) ok++; } });
  $("drill-chip").textContent = done ? ok + "/" + ds.length + " correct" : ds.length + " questions";
  $("drill-chip").className = "chip" + (done === ds.length && ds.length ? (ok === ds.length ? " good" : " mark") : "");
  renderPlan();
}

// ---------- speak freely ----------
function wireSpeak() {
  const btn = $("speak-rec");
  btn.classList.add("pill"); setButton(btn, "mic", "Start speaking");
  $("speak-fb").classList.add("pill");
  btn.onclick = () => toggleRec({ key: "speak", btn, live: $("speak-live"), done: (t) => { session.speak = ((session.speak || "") + " " + t).trim(); $("speak-text").textContent = session.speak; updateAIButtons(); saveSession(); } });
  $("speak-fb").onclick = () => {
    if (!sample || !session.speak) return;
    const out = $("speak-feedback"), b = $("speak-fb"); out.hidden = false; out.textContent = "Thinking…"; b.disabled = true;
    const prompt = "You are a native English teacher giving feedback to a Spanish-speaking adult aiming at C1/C2 speaking. " +
      "The question was: \"" + $("speak-prompt").textContent + "\"\nThis is a speech-recognition transcript of the learner's spoken answer (ignore missing punctuation):\n\"" + session.speak + "\"\n\n" +
      "Write plain text, no markdown, at most 170 words, in this order:\n" +
      "1) One sentence on what they did well.\n" +
      "2) Corrections: up to 4 lines, each as: what they said -> a natural correction (brief reason in Spanish). Watch articles, third-person -s, tenses, prepositions and word order.\n" +
      "3) Upgrade: 2 phrases they used, each rewritten with a C1/C2 word or idiom.\n" +
      "4) One sentence for them to repeat aloud now.";
    sample.ask(prompt, { effort: "low", onText: (u) => { out.textContent = u.text; } })
      .then(() => { b.disabled = false; })
      .catch((e) => { out.textContent = aiError(e, "The feedback"); b.disabled = false; });
  };
}
function updateAIButtons() {
  $("speak-fb").disabled = !sample || !session.speak;
  $("speak-fb").title = sample ? "" : "Add your API key in Settings";
  renderFix();
  const needToday = !lessonIsToday;
  $("make-lesson").hidden = !(sample && needToday);
}

// ---------- review + progress ----------
function dueList() { return Object.values(vocabDocs).filter((d) => d.due && d.due <= TODAY).sort((a, b) => (a.due < b.due ? -1 : 1)); }
function renderDue() {
  const due = dueList(), g = $("due-list"); g.textContent = "";
  $("due-chip").textContent = due.length + " due"; $("due-empty").hidden = due.length > 0;
  due.slice(0, 12).forEach((d) => g.appendChild(vocabCard(d, true)));
}
function hardList() { return Object.values(troub).filter((t) => (t.misses || 0) > (t.hits || 0)).sort((a, b) => (b.misses - (b.hits || 0)) - (a.misses - (a.hits || 0))); }
function renderHard() {
  const list = hardList().slice(0, 12), box = $("hard-list"); box.textContent = ""; $("hard-empty").hidden = list.length > 0;
  list.forEach((t) => box.appendChild(wordRow(t)));
}
function streak() {
  const days = {}; allSessions.forEach((s) => { if (s.accuracy != null) days[s.date] = 1; });
  let d = days[TODAY] ? TODAY : addDays(TODAY, -1), n = 0; while (days[d]) { n++; d = addDays(d, -1); } return n;
}
function renderProgress() {
  const done = allSessions.filter((s) => s.accuracy != null).sort((a, b) => (a.date < b.date ? 1 : -1));
  const st = streak();
  $("streak").textContent = st ? st + "-day streak" : "No streak yet";
  $("streak").className = "chip" + (st ? " good" : ""); $("st-streak").textContent = st; $("st-days").textContent = done.length;
  $("st-acc").textContent = done.length ? Math.round(done.reduce((a, s) => a + s.accuracy, 0) / done.length) + "%" : "–";
  $("st-vocab").textContent = Object.keys(vocabDocs).length;
  const bars = $("bars"); bars.textContent = ""; $("bars-empty").hidden = done.length > 0;
  done.slice(0, 14).forEach((s) => { const r = el("div", "bar"); r.appendChild(el("span", "", s.date)); const t = el("div", "track"), f = el("div", "fill"); f.style.width = s.accuracy + "%"; t.appendChild(f); r.append(t, el("span", "", s.accuracy + "%")); bars.appendChild(r); });
  const tb = $("miss-table"); tb.textContent = "";
  const rows = Object.values(troub).sort((a, b) => (b.misses || 0) - (a.misses || 0)).slice(0, 25);
  if (!rows.length) { const tr0 = el("tr"); const td0 = el("td", "hint", "No missed words recorded yet."); td0.colSpan = 5; tr0.appendChild(td0); tb.appendChild(tr0); }
  rows.forEach((t) => { const tr = el("tr"); tr.append(el("td", "", t.word), el("td", "ipa", (t.coach && t.coach.ipa) || ""), el("td", "num", String(t.misses || 0)), el("td", "num", String(t.hits || 0)), el("td", "", t.last || "")); tb.appendChild(tr); });
}

// ---------- lesson creation (asks Claude) ----------
let making = false;
function makeLesson() {
  if (!sample || making) return;
  making = true;
  const b = $("make-lesson"); b.hidden = false; b.disabled = true; b.textContent = "Writing your story…";
  status("Claude is writing today's story. This can take up to a minute.");
  const hard = hardList().slice(0, 8).map((t) => t.word).join(", ") || "none yet";
  const recent = store.all("lessons").sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 7).map((l) => l.title).filter(Boolean).join("; ") || "none";
  const prompt = "Create today's English lesson for a Spanish-speaking senior QA engineer practising reading aloud. Level: natural C1 prose with exactly 7 C2-level words. " +
    "Topic: alternate between everyday life and software/QA work; avoid these recent titles: " + recent + ". Reuse some of the learner's difficult words if natural: " + hard + ". No digits, write numbers as words. American spelling.\n" +
    "Reply with only a JSON object with these fields:\n" +
    '"title": string; "level": "C1 + C2 words"; "topic": string;\n' +
    '"sentences": array of 9 to 11 sentences forming one story (12 to 22 words each);\n' +
    '"vocab": array of 7 objects {"word","inStory" (exact form used in the story),"ipa" (General American, between slashes),"say" (respelling for Spanish speakers, stressed syllable in CAPITALS),"pos","level" ("C1" or "C2"),"meaning" (short English definition),"es" (Spanish translation),"example" (a new sentence)};\n' +
    '"focus": {"title" (one pronunciation point present in the story),"tip" (2 sentences in Spanish),"items": array of 5 to 7 {"text" (word or minimal pair from the story),"note" (IPA and a 3 to 6 word cue)}};\n' +
    '"drills": array of 4 {"prompt" (sentence with ____ for one vocab word),"options" (4 strings),"answer" (one of the options),"why" (one short sentence)};\n' +
    '"speak": one open question related to the story.';
  sample.askJSON(prompt, { effort: "medium" }).then((L) => {
    if (!L || !Array.isArray(L.sentences) || !L.sentences.length) throw { code: "invalid_json" };
    L.date = TODAY; L.source = "app"; lesson = L; lessonIsToday = true; status("");
    save("lessons", TODAY, L);
    session = { date: TODAY, reads: {}, missed: [], drills: {}, speak: "" };
    renderLesson(); seedVocab(); renderDue(); renderProgress();
  }).catch((e) => {
    status(aiError(e, "Today's story"));
  }).finally(() => {
    making = false; b.disabled = false; b.textContent = "Create today's story"; updateAIButtons();
  });
}

// ---------- settings ----------
function refreshAI() {
  sample = createAI(getSetting("apiKey", ""), getSetting("model", DEFAULT_MODEL));
}
function renderSettings() {
  const sel = $("set-model"); sel.textContent = "";
  MODELS.forEach((m) => { const o = el("option", "", m.label); o.value = m.id; sel.appendChild(o); });
  sel.value = getSetting("model", DEFAULT_MODEL);
  $("set-key").value = getSetting("apiKey", "");
  $("set-auto").checked = getSetting("autoLesson", true);
  $("set-pause").value = getSetting("pause", "long");
  $("set-expect").checked = getSetting("expectWords", true);
  const chip = $("ai-chip"); chip.textContent = sample ? "Connected" : "No API key"; chip.className = "chip " + (sample ? "good" : "mark");
  const info = $("dev-info"); info.textContent = "";
  const platformName = { web: "Web browser", ios: "Mac app" }[PLATFORM] || PLATFORM;
  [
    "Platform: " + platformName,
    "Microphone (speech recognition): " + (dict ? "available" : "not available"),
    "Voice (text to speech): " + (ttsAvailable() ? "available" : "not available"),
    "Claude: " + (sample ? "connected with " + sample.model : "no API key"),
  ].forEach((t) => info.appendChild(el("li", "", t)));
}
function wireSettings() {
  $("set-pause").onchange = () => setSettings({ pause: $("set-pause").value });
  $("set-expect").onchange = () => setSettings({ expectWords: $("set-expect").checked });
  $("log-copy").onclick = async () => {
    const box = $("log-text"), msg = $("log-msg");
    const text = micLog();
    if (!text) { msg.textContent = "The log is empty. Read a sentence first."; box.hidden = true; return; }
    box.value = text; box.hidden = false;
    try { await navigator.clipboard.writeText(text); msg.textContent = "Copied. Paste it in your message (⌘V)."; }
    catch (e) { box.focus(); box.select(); msg.textContent = "Selected below: press ⌘C to copy it."; }
  };
  $("set-save").onclick = async () => {
    await setSettings({ apiKey: $("set-key").value.trim(), model: $("set-model").value, autoLesson: $("set-auto").checked });
    refreshAI(); renderSettings(); updateAIButtons();
    $("set-msg").textContent = sample ? "Saved." : "Saved. Without an API key you can still use the starter story and the stories you already have.";
  };
  $("set-test").onclick = async () => {
    const ai = createAI($("set-key").value.trim(), $("set-model").value);
    if (!ai) { $("set-msg").textContent = "Enter an API key first."; return; }
    $("set-msg").textContent = "Testing…";
    try { await ai.ask("Reply with the single word: ready"); $("set-msg").textContent = "Connected. Press Save to keep this key."; }
    catch (e) { $("set-msg").textContent = aiError(e, "A test answer").replace(" could not be created.", " failed."); }
  };
  $("exp-btn").onclick = async () => {
    try { await saveTextFile("daily-english-backup-" + TODAY + ".json", JSON.stringify(store.exportAll(), null, 1)); $("data-msg").textContent = "Backup ready."; }
    catch (e) { $("data-msg").textContent = "The backup could not be saved."; }
  };
  $("imp-btn").onclick = () => $("imp-file").click();
  $("imp-file").onchange = async (ev) => {
    const f = ev.target.files && ev.target.files[0]; ev.target.value = ""; if (!f) return;
    try {
      const n = await store.importAll(JSON.parse(await f.text()));
      $("data-msg").textContent = "Imported " + n + " records.";
      loadFromStore();
    } catch (e) { $("data-msg").textContent = "That file is not a Daily English backup."; }
  };
}

// ---------- routing ----------
const TABS = ["today", "review", "progress", "settings"];
function route() {
  let h = (location.hash || "#today").slice(1); if (TABS.indexOf(h) < 0) h = "today";
  TABS.forEach((t) => $("view-" + t).classList.toggle("on", t === h));
  document.querySelectorAll("nav.tabs a").forEach((a) => { if (a.dataset.tab === h) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (h !== "today") { if (rec) stopRec("cancel"); endFlow(); }
  if (h === "settings") renderSettings();
  if (statusKey === "nokey") $("status").hidden = h === "settings";
}

// ---------- load ----------
function loadFromStore() {
  allSessions = store.all("sessions");
  troub = {}; store.all("words").forEach((t) => { if (t.word) troub[t.word] = t; });
  vocabDocs = {}; store.all("vocab").forEach((v) => { if (v.word) vocabDocs[docId(v.word)] = v; });
  const todays = store.get("lessons", TODAY);
  const latest = store.all("lessons").sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (todays) { lesson = todays; lessonIsToday = true; }
  else if (latest) { lesson = latest; lessonIsToday = false; }
  else { lesson = JSON.parse(JSON.stringify(STARTER)); lessonIsToday = false; }
  const mine = allSessions.find((s) => s.date === TODAY);
  session = (mine && mine.lesson === lesson.date)
    ? { date: TODAY, reads: mine.reads || {}, missed: mine.missed || [], drills: mine.drills || {}, speak: mine.speak || "" }
    : { date: TODAY, reads: {}, missed: [], drills: {}, speak: "" };
  renderLesson(); seedVocab(); renderDue(); renderHard(); renderProgress();
  if (!lessonIsToday) {
    if (sample && getSetting("autoLesson", true)) makeLesson();
    else if (sample) status("Today's story is not ready yet. This is the latest one. You can create today's story now.", { key: "notready-" + TODAY });
    else status("Add your Anthropic API key to get a new story every day. Until then, practice with this one.", { key: "nokey", action: { label: "Open Settings", href: "#settings" } });
  }
}

async function init() {
  window.addEventListener("hashchange", route);
  $("today-date").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  $("coach-btn").onclick = coach;
  $("make-lesson").onclick = makeLesson;
  $("done-fix").onclick = () => goToCard("fix-card");
  $("done-again").onclick = () => { endFlow(); readFrom(0); };
  await openStore();
  wireStatus(); wireReader(); wireSpeak(); wireSettings();
  refreshAI();
  try { dict = await createDictation(); } catch (e) { dict = null; }
  if (dict) wireDictation();
  loadFromStore();
  route();
  if (!dict && $("status").hidden) status(micHelp() + " Listening and exercises work here.", { key: "nomic" });

  if (PLATFORM === "web" && "serviceWorker" in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}
init().catch((e) => { console.error(e); status("The app could not start: " + ((e && e.message) || "error")); });
