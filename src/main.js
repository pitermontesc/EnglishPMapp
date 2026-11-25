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
import { createDictation } from "./platform/speech.js";
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

// ---------- state ----------
let dict = null, sample = null;
let lesson = null, lessonIsToday = false;
let session = { date: TODAY, reads: {}, missed: [], drills: {}, speak: "" };
let allSessions = [], troub = {}, vocabDocs = {};
let rec = null; // active recording {key, buf, btn, live, label, done}
function save(col, id, body) { store.set(col, id, body).catch((e) => status("Could not save: " + ((e && e.code) || "error") + ". Your results stay on screen.")); }
function status(msg) { const s = $("status"); if (!msg) { s.hidden = true; return; } s.textContent = msg; s.hidden = false; }
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

// ---------- audio out ----------
function say(text, rate) {
  speak(text, rate || 1).catch(() => status("Audio is not available on this device."));
}
function stopAudio() { stopSpeech(); }

// ---------- microphone ----------
function micHelp() {
  if (PLATFORM === "web") return "Reading aloud needs speech recognition: open the app in Google Chrome, or use the Mac app.";
  return "Speech recognition is not available on this device. Check that dictation is enabled in the system settings.";
}
function toggleRec(o) {
  if (!dict) { status(micHelp()); return; }
  if (rec) { if (rec.key === o.key) dict.stop().catch(() => {}); return; }
  stopAudio();
  rec = { key: o.key, buf: "", btn: o.btn, live: o.live, label: o.btn.textContent, done: o.done };
  o.btn.textContent = "Stop"; o.btn.classList.add("rec");
  if (o.live) o.live.textContent = "Listening…";
  dict.start({ language: "en" }).catch((e) => finishRec(e && e.code));
}
function finishRec(reason) {
  if (!rec) return;
  const r = rec; rec = null;
  r.btn.textContent = r.label; r.btn.classList.remove("rec");
  if (r.live) r.live.textContent = "";
  const text = r.buf.trim();
  if (!text) {
    if (reason === "not_granted") status("The microphone or speech recognition permission is off. Turn it on for Daily English in the system settings (or the browser's site settings) and try again.");
    else if (reason === "no_microphone") status("No microphone was found.");
    else if (reason === "network") status("Speech recognition in this browser needs an internet connection.");
    else if (reason === "unavailable") status("Speech recognition is not available right now.");
    else if (r.live) r.live.textContent = "Nothing was heard. Try again a little closer to the microphone.";
    return;
  }
  status("");
  r.done(text);
}
function wireDictation() {
  dict.onFinal((e) => { if (rec) rec.buf += e.text; });
  dict.onPartial((e) => { if (rec && rec.live) rec.live.textContent = (rec.buf + " " + e.text).trim() || "Listening…"; });
  dict.onState((e) => { if (e.state === "idle") finishRec(e.reason); });
}

// ---------- today: story ----------
function vocabSet() {
  const s = {}; (lesson.vocab || []).forEach((v) => { words(v.inStory || v.word).forEach((w) => { if (w.length > 3) s[w] = 1; }); }); return s;
}
function renderLesson() {
  $("lesson-title").textContent = lesson.title || "Today's story";
  $("lesson-kicker").textContent = (lessonIsToday ? "Today's story" : (lesson.source === "bundled" ? "Starter story" : "Latest story, " + lesson.date)) + (lesson.level ? " · " + lesson.level : "");
  $("story-hint").textContent = "Listen to a sentence, then press Read it and say it aloud. Press Stop when you finish. Green words were understood; red words were not.";
  const box = $("sentences"); box.textContent = "";
  const vs = vocabSet();
  (lesson.sentences || []).forEach((text, idx) => {
    const row = el("div", "sent");
    const p = el("p", "sent-text");
    String(text).split(/\s+/).forEach((raw, k) => {
      if (k) p.appendChild(document.createTextNode(" "));
      const sp = el("span", "tok", raw); sp.dataset.n = words(raw).join(" ");
      if (words(raw).some((w) => vs[w])) sp.classList.add("vocab");
      p.appendChild(sp);
    });
    const ctl = el("div", "row");
    const b1 = el("button", "", "Listen"); b1.onclick = () => say(text, 1);
    const b2 = el("button", "", "Slow"); b2.onclick = () => say(text, 0.75);
    const b3 = el("button", "primary", "Read it");
    const pill = el("span", "chip", ""); pill.hidden = true;
    const live = el("div", "live");
    const heard = el("div", "heard");
    b3.onclick = () => toggleRec({ key: "s" + idx, btn: b3, live, done: (t) => gradeSentence(idx, t) });
    ctl.append(b1, b2, b3, pill);
    row.append(p, ctl, live, heard);
    row._p = p; row._pill = pill; row._heard = heard;
    box.appendChild(row);
    const prev = session.reads[idx];
    if (prev) paintSentence(row, text, prev.heard);
  });
  $("speak-prompt").textContent = lesson.speak || "Retell today's story in your own words.";
  $("speak-text").textContent = session.speak || "";
  $("speak-feedback").hidden = true;
  renderFocus(); renderVocab(); renderDrills(); renderFix(); updateAcc(); updateAIButtons();
}
function paintSentence(row, text, heardText) {
  const target = words(text), res = align(target, words(heardText)), missed = [];
  let k = 0, hit = 0;
  row._p.querySelectorAll(".tok").forEach((sp) => {
    const parts = sp.dataset.n ? sp.dataset.n.split(" ") : []; if (!parts.length) return;
    let ok = true;
    parts.forEach((w) => { const r = res[k++]; if (r && r.ok) hit++; else { ok = false; missed.push({ word: w, heard: r ? r.heard : "" }); } });
    sp.classList.remove("ok", "miss"); sp.classList.add(ok ? "ok" : "miss");
  });
  const pct = target.length ? Math.round(100 * hit / target.length) : 0;
  row._pill.hidden = false; row._pill.textContent = pct + "% understood";
  row._pill.className = "chip " + (pct >= 90 ? "good" : pct >= 70 ? "mark" : "miss");
  row._heard.textContent = ""; row._heard.append("Heard: ", el("b", "", heardText));
  return { hit, total: target.length, missed };
}
function gradeSentence(idx, heardText) {
  const row = $("sentences").children[idx], text = lesson.sentences[idx];
  const g = paintSentence(row, text, heardText);
  session.reads[idx] = { heard: heardText, hit: g.hit, total: g.total };
  const touched = [];
  g.missed.forEach((m) => {
    if (m.word.length < 3) return;
    const t = troub[m.word] || (troub[m.word] = { word: m.word, misses: 0, hits: 0 });
    t.misses++; t.last = TODAY; t.heardAs = m.heard || ""; touched.push(m.word);
    if (session.missed.indexOf(m.word) < 0) session.missed.push(m.word);
  });
  saveSession(); touched.forEach(saveWord);
  renderFix(); updateAcc(); renderProgress();
}
function accuracy(s) { let h = 0, t = 0; Object.keys(s.reads || {}).forEach((k) => { h += s.reads[k].hit; t += s.reads[k].total; }); return t ? Math.round(100 * h / t) : null; }
function updateAcc() {
  const a = accuracy(session), n = Object.keys(session.reads).length, c = $("acc-chip");
  if (a == null) { c.textContent = "Not read yet"; c.className = "chip"; return; }
  c.textContent = a + "% understood · " + n + "/" + (lesson.sentences || []).length + " sentences";
  c.className = "chip " + (a >= 90 ? "good" : a >= 70 ? "mark" : "miss");
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
  const b1 = el("button", "", "Listen"); b1.onclick = () => say(t.word, 0.8);
  const b2 = el("button", "primary", "Say it");
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
  (f.items || []).forEach((it) => { const c = el("div", "vcard"); c.appendChild(el("div", "vword", it.text)); if (it.note) c.appendChild(el("div", "ipa", it.note)); const b = el("button", "", "Listen"); b.onclick = () => say(it.text, 0.8); c.appendChild(b); g.appendChild(c); });
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
  const b = el("button", "", "Listen"); b.onclick = () => say(v.word + ". " + (v.example || ""), 0.9); ctl.appendChild(b);
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
}

// ---------- speak freely ----------
function wireSpeak() {
  const btn = $("speak-rec");
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
  $("streak").textContent = "Streak " + st + (st === 1 ? " day" : " days"); $("st-streak").textContent = st; $("st-days").textContent = done.length;
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
  if (h === "settings") renderSettings();
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
    else if (sample) status("Today's story is not ready yet. This is the latest one. You can create today's story now.");
    else status("Add your Anthropic API key in Settings to get a new story every day. Until then, practice with this one.");
  }
}

async function init() {
  window.addEventListener("hashchange", route);
  $("today-date").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  $("listen-all").onclick = () => { if (lesson) say((lesson.sentences || []).join(" "), 1); };
  $("listen-slow").onclick = () => { if (lesson) say((lesson.sentences || []).join(" "), 0.75); };
  $("stop-audio").onclick = stopAudio;
  $("coach-btn").onclick = coach;
  $("make-lesson").onclick = makeLesson;
  wireSpeak(); wireSettings();

  await openStore();
  refreshAI();
  try { dict = await createDictation(); } catch (e) { dict = null; }
  if (dict) wireDictation();
  loadFromStore();
  route();
  if (!dict && $("status").hidden) status(micHelp() + " Listening and exercises work here.");

  if (PLATFORM === "web" && "serviceWorker" in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}
init().catch((e) => { console.error(e); status("The app could not start: " + ((e && e.message) || "error")); });
