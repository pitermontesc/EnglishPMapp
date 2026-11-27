// End-to-end drill of a whole practice day, including a spoken conversation with Claude.
// Runs the real built app in headless Chrome with three stand-ins:
//   - a fake microphone (Web Speech API) that "says" scripted lines,
//   - a fake voice (speech synthesis) that finishes instantly,
//   - a fake Claude: calls to api.anthropic.com are answered in the page with streamed replies.
// Nothing is sent over the network and the real microphone is never opened.
// Run: npm run test:e2e
import { preview } from "vite";
import puppeteer from "puppeteer-core";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(CHROME)) { console.error("Chrome not found. Set CHROME_PATH."); process.exit(2); }

// ---------- what the learner and Claude say ----------
const LESSON = {
  title: "The Quiet Release", level: "C1 + C2 words", topic: "work",
  sentences: [
    "Our release went out on Monday without a single alert.",
    "The team celebrated quietly because nobody trusted the silence yet.",
    "By Friday the dashboards proved that the fix was genuinely robust.",
  ],
  vocab: [{ word: "robust", inStory: "robust", ipa: "/roʊˈbʌst/", say: "rou-BAST", pos: "adjective", level: "C1", meaning: "strong and reliable", es: "robusto", example: "We need a robust test suite." }],
  focus: { title: "Past tense -ed", tip: "Pronuncia la terminación -ed.", items: [{ text: "celebrated", note: "/ˈsɛləbreɪtɪd/ final -id" }] },
  drills: [
    { prompt: "By Friday the fix was genuinely ____.", options: ["robust", "fragile", "silent", "late"], answer: "robust", why: "Robust means strong and reliable." },
    { prompt: "Nobody ____ the silence yet.", options: ["trusted", "robust", "alert", "release"], answer: "trusted", why: "A past-tense verb is needed." },
  ],
  speak: "Tell me about a release at work that went better than you expected.",
};
// The learner drops the -ed of "celebrated" in sentence 2 (a typical Spanish-speaker slip).
const READING = [LESSON.sentences[0], "The team celebrate quietly because nobody trusted the silence yet.", LESSON.sentences[2]];
const ANSWER_1 = "Last year we launch a new checkout and I was very nervous for the release";
const ANSWER_2 = "but in the end the monitoring was quiet and the customers was happy";
const COACH = { celebrated: { ipa: "/ˈsɛləbreɪtɪd/", say: "SE-le-brei-tid", tip: "Los hispanohablantes suelen omitir la -ed final. Después de t, pronuncia una sílaba extra: -id.", pair: "celebrate / celebrated", examples: ["We celebrated the launch.", "They celebrated quietly.", "She celebrated her promotion."] } };
const FEEDBACK = [
  "You told a clear story with a good beginning and end.\n",
  "Corrections:\n",
  "we launch -> we launched (pasado: añade -ed)\n",
  "nervous for the release -> nervous about the release (preposición)\n",
  "the customers was happy -> the customers were happy (plural: were)\n",
  "Upgrade: very nervous -> on edge; was quiet -> stayed eerily quiet\n",
  "Repeat: Last year we launched a new checkout, and I was on edge about the release.",
];
const REPEAT = "Last year we launched a new checkout and I was on edge about the release";

// ---------- the stand-ins injected into the page before the app loads ----------
function standIns(lesson, coach, feedback) {
  window.__say = [];          // lines the fake microphone will say, in order
  window.__micDenied = false; // simulate a refused microphone permission
  window.__claude = [];       // prompts received by the fake Claude
  window.__badKeys = ["sk-ant-bad"];

  class FakeRecognition {
    start() {
      if (window.__micDenied) { setTimeout(() => { this.onerror && this.onerror({ error: "not-allowed" }); this.onend && this.onend(); }, 20); return; }
      const line = window.__say.shift() || "";
      const ws = line.split(" ").filter(Boolean);
      let i = 0; this.done = false;
      this.timer = setInterval(() => {
        if (this.done) return;
        i++;
        if (i <= ws.length) {
          const said = ws.slice(0, i).join(" "), last = i === ws.length;
          this.onresult && this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: said }], { isFinal: last })] });
        }
        if (i >= ws.length) clearInterval(this.timer); // then silence until the app stops listening
      }, 70);
    }
    stop() { this.done = true; clearInterval(this.timer); setTimeout(() => this.onend && this.onend(), 30); }
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeRecognition;

  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  Object.defineProperty(window, "speechSynthesis", { value: {
    getVoices: () => [{ name: "Samantha", lang: "en-US" }], onvoiceschanged: null,
    speak: (u) => setTimeout(() => u.onend && u.onend(), 40), cancel() {},
  } });

  // Fake Claude: answers Messages API calls with a streamed reply, like the real API.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://api.anthropic.com")) return realFetch(input, init);
    // The SDK may pass a Request object or (url, init): read the body and headers from either.
    const req = input instanceof Request ? input : null;
    const headers = new Headers(req ? req.headers : undefined);
    new Headers((init && init.headers) || undefined).forEach((v, k) => headers.set(k, v));
    const body = JSON.parse(init && init.body ? (typeof init.body === "string" ? init.body : await new Response(init.body).text()) : await req.clone().text());
    const prompt = body.messages[0].content;
    const key = headers.get("x-api-key") || (headers.get("authorization") || "").replace(/^Bearer /, "");
    window.__claude.push({ model: body.model, prompt, stream: body.stream, effort: body.output_config && body.output_config.effort, key, headerNames: [...headers.keys()] });
    if (window.__badKeys.includes(key)) {
      return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } });
    }
    let parts;
    if (prompt.includes("Reply with the single word: ready")) parts = ["ready"];
    else if (prompt.includes("Create today's English lesson")) parts = [JSON.stringify(lesson)];
    else if (prompt.includes("pronunciation coach")) parts = [JSON.stringify(coach)];
    else if (prompt.includes("giving feedback")) parts = feedback;
    else parts = ["(unexpected prompt)"];
    const ev = (type, data) => "event: " + type + "\ndata: " + JSON.stringify(Object.assign({ type }, data)) + "\n\n";
    const chunks = [ev("message_start", { message: { id: "msg_test", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } }),
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } })];
    parts.forEach((p) => chunks.push(ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: p } })));
    chunks.push(ev("content_block_stop", { index: 0 }), ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 100 } }), ev("message_stop", {}));
    const enc = new TextEncoder();
    const stream = new ReadableStream({ async start(c) { for (const ch of chunks) { c.enqueue(enc.encode(ch)); await new Promise((r) => setTimeout(r, 15)); } c.close(); } });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
  };
}

// ---------- runner ----------
const results = [];
function check(name, ok, detail = "") { results.push({ name, ok: !!ok, detail }); console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok || !detail ? "" : "  → " + detail)); }
const transcript = [];

const server = await preview({ preview: { port: 4319, strictPort: true }, logLevel: "silent" });
const base = "http://localhost:4319/";
const profile = mkdtempSync(join(tmpdir(), "de-e2e-"));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ["--no-first-run", "--no-default-browser-check", "--window-size=1100,1000"], defaultViewport: { width: 1100, height: 1000 } });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
await page.evaluateOnNewDocument(standIns, LESSON, COACH, FEEDBACK);

const text = (sel) => page.$eval(sel, (e) => e.textContent.trim());
const visible = (sel) => page.$eval(sel, (e) => !e.hidden && e.offsetParent !== null).catch(() => false);
const waitText = (sel, re, timeout = 15000) => page.waitForFunction((s, src) => { const e = document.querySelector(s); return e && new RegExp(src).test(e.textContent); }, { timeout }, sel, re.source);
const say = (...lines) => page.evaluate((ls) => { window.__say.push(...ls); }, lines);
const plan = () => page.$$eval(".step", (els) => els.map((e) => ({ done: e.classList.contains("done"), text: e.textContent })));
const clickText = (sel, label) => page.evaluate((s, l) => { const b = [...document.querySelectorAll(s)].find((x) => x.textContent.trim() === l); if (!b) throw new Error("no button " + l); b.click(); }, sel, label);

try {
  console.log("\n1. First launch");
  await page.goto(base + "#today", { waitUntil: "networkidle0" });
  await page.waitForSelector(".sent");
  check("starter story is shown", (await text("#lesson-title")).length > 0);
  check("asks for an API key", /Anthropic API key/.test(await text("#status-text")));
  check("plan starts at 0 read", (await plan())[0].text.includes("0/"));

  console.log("\n2. Settings: a wrong key, then the right one");
  await page.goto(base + "#settings"); await page.waitForSelector("#set-key");
  check("the 'add your key' note is hidden on Settings", !(await visible("#status")));
  await page.type("#set-key", "sk-ant-bad");
  await page.click("#set-test");
  await waitText("#set-msg", /rejected/);
  check("a rejected key is explained", /The API key was rejected/.test(await text("#set-msg")));
  await page.$eval("#set-key", (e) => { e.value = ""; });
  await page.type("#set-key", "sk-ant-test-0000");
  await page.click("#set-test");
  await waitText("#set-msg", /Connected/);
  check("test connection succeeds", true);
  await page.click("#set-save");
  await waitText("#set-msg", /Saved/);
  check("settings show Claude connected", (await text("#ai-chip")) === "Connected");

  console.log("\n3. Microphone refused");
  await page.evaluate(() => { window.__micDenied = true; });
  await page.goto(base + "#today"); await page.waitForSelector(".sent");
  await page.click("#r-read");
  await waitText("#status-text", /permission is off/);
  check("explains how to allow the microphone", true);
  await page.evaluate(() => { window.__micDenied = false; });
  check("the Read button is back to idle", (await text("#r-read")) === "Read");

  console.log("\n4. Claude writes today's story");
  await page.goto(base + "#today"); await page.waitForSelector("#make-lesson:not([hidden])");
  await page.click("#make-lesson");
  await waitText("#lesson-title", /The Quiet Release/, 20000);
  check("today's story replaces the starter", (await page.$$(".sent")).length === 3);
  check("the plan counts the new story", (await plan())[0].text.includes("0/3"));
  const lessonCall = (await page.evaluate(() => window.__claude)).find((c) => c.prompt.includes("Create today's English lesson"));
  check("the lesson request uses streaming and medium effort", lessonCall && lessonCall.stream === true && lessonCall.effort === "medium");

  console.log("\n5. Reading the story hands-free (one slip in sentence 2)");
  check("the active sentence says what to do", /Press Read/.test(await text(".sent.active .sent-live")));
  await say(...READING);
  await page.click("#r-read");
  await page.waitForFunction(() => !document.getElementById("story-done").hidden, { timeout: 30000 });
  const scores = await page.$$eval(".sent .score", (els) => els.map((e) => e.textContent));
  check("sentence scores are 100%, under 100%, 100%", scores[0] === "100%" && scores[1] !== "100%" && scores[2] === "100%", scores.join(" "));
  const missed = await page.$$eval(".tok.miss", (els) => els.map((e) => e.textContent));
  check("only the slipped word is red", missed.length === 1 && missed[0] === "celebrated", missed.join(","));
  check("'Heard' shows what was understood", /celebrate quietly/.test(await page.$eval(".sent:nth-child(2) .sent-live", (e) => e.textContent)));
  check("the summary reports one word to practice", /1 word was not understood/.test(await text("#done-text")));
  let p = await plan();
  check("plan: story read, 1 word to fix", p[0].done && /1 left/.test(p[1].text));
  check("the header shows a 1-day streak", (await text("#streak")) === "1-day streak");

  console.log("\n6. Fixing the word");
  await page.click("#done-fix");
  await page.click("#coach-btn");
  await waitText("#fix-list", /omitir la -ed/, 15000);
  check("Claude's coaching tip appears (in Spanish)", true);
  check("the word shows what was heard", /heard as “celebrate”/.test(await text("#fix-list")));
  await say("celebrated");
  await clickText("#fix-list button", "Say it");
  await new Promise((r) => setTimeout(r, 400));
  await clickText("#fix-list button", "Stop");
  await waitText("#fix-list", /Well done/);
  check("saying the word correctly is confirmed", true);
  p = await plan();
  check("plan: words fixed", p[1].done);

  console.log("\n7. Exercises (one right, one wrong)");
  await clickText("#drills .drill:nth-child(1) button", "robust");
  check("the chip counts answered questions until all are done", (await text("#drill-chip")) === "1/2 answered");
  await clickText("#drills .drill:nth-child(2) button", "robust"); // second drill: wrong answer
  check("right and wrong answers are marked", (await page.$$("#drills .right")).length === 2 && (await page.$$("#drills .wrong")).length === 1);
  check("the score shows 1/2 correct", (await text("#drill-chip")) === "1/2 correct");
  check("plan: exercises done", (await plan())[2].done);

  console.log("\n8. Conversation: Speak freely with Claude's feedback");
  const question = await text("#speak-prompt");
  transcript.push(["App", question]);
  check("the question comes from today's story", question === LESSON.speak);
  for (const line of [ANSWER_1, ANSWER_2]) {
    await say(line);
    await page.click("#speak-rec");
    await new Promise((r) => setTimeout(r, line.split(" ").length * 70 + 300));
    await page.click("#speak-rec"); // Stop
    await page.waitForFunction((l) => document.getElementById("speak-text").textContent.includes(l), {}, line);
    transcript.push(["Learner", line]);
  }
  check("both spoken turns are in the transcript", (await text("#speak-text")) === ANSWER_1 + " " + ANSWER_2);
  await page.click("#speak-fb");
  await waitText("#speak-feedback", /Repeat:/, 15000);
  const fb = await text("#speak-feedback");
  transcript.push(["Claude", fb]);
  check("Claude's feedback streams in with corrections", /we launch -> we launched/.test(fb) && /customers were happy/.test(fb));
  const fbCall = (await page.evaluate(() => window.__claude)).find((c) => c.prompt.includes("giving feedback"));
  check("the feedback request includes the question and what was said", fbCall && fbCall.prompt.includes(LESSON.speak) && fbCall.prompt.includes(ANSWER_2));
  await say(REPEAT);
  await page.click("#speak-rec");
  await new Promise((r) => setTimeout(r, REPEAT.split(" ").length * 70 + 300));
  await page.click("#speak-rec");
  await page.waitForFunction((l) => document.getElementById("speak-text").textContent.includes(l), {}, REPEAT);
  transcript.push(["Learner", REPEAT]);
  check("the learner's corrected sentence is added", (await text("#speak-text")).endsWith(REPEAT));
  p = await plan();
  check("plan: all four steps done", p.every((s) => s.done), p.map((s) => s.text).join(" | "));

  console.log("\n9. Progress and persistence");
  await page.goto(base + "#progress"); await page.waitForSelector("#bars");
  check("progress shows 1 day practiced", (await text("#st-days")) === "1");
  check("the missed word is in the table", /celebrated/.test(await text("#miss-table")));
  await page.goto(base + "#today", { waitUntil: "networkidle0" }); await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".sent .score:not([hidden])");
  check("after reopening, the results are still there", (await page.$$(".tok.miss")).length === 1 && (await plan()).every((s) => s.done));

  check("no errors in the page", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  check("drill ran to the end", false, e.message);
  await page.screenshot({ path: join(tmpdir(), "de-e2e-failure.png") }).catch(() => {});
  console.log("  screenshot: " + join(tmpdir(), "de-e2e-failure.png"));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
  rmSync(profile, { recursive: true, force: true });
}

if (transcript.length) {
  console.log("\nSimulated conversation");
  transcript.forEach(([who, t]) => console.log("  " + who.padEnd(8) + t.replace(/\n/g, "\n" + " ".repeat(10))));
}
const failed = results.filter((r) => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " checks passed");
process.exit(failed.length ? 1 : 0);
