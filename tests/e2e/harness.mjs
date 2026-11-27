// Shared pieces of the end-to-end drills: the stand-ins injected into the page, the browser
// launcher and the check/report helpers. Nothing here opens the real microphone or the network.
import { preview } from "vite";
import puppeteer from "puppeteer-core";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ---------- the stand-ins injected into the page before the app loads ----------
// Controls the drills can set from the page:
//   __say          lines the fake microphone will say, in order; " | " inside a line makes the
//                  recognizer close by itself at that point (as Chrome's and Apple's sometimes do)
//   __wordMs       time per spoken word (default 70 ms)
//   __micError     next start fails with this Web Speech error ("not-allowed", "network", ...)
//   __micDown      every start fails with this error until cleared (e.g. Chrome with no internet)
//   __spoken       what the app said aloud: [{ text, rate }]
//   __ttsMs        how long each spoken sentence lasts (default 40 ms)
//   __claude       requests received by the fake Claude
//   __claudeNext   scripted outcomes for the next Claude calls, consumed in order:
//                  { status, errorType } | { text } | { stopReason } | { offline: true }
//   __offline      while true, every Claude call fails as if there were no connection
export function standIns(cfg) {
  window.__say = []; window.__wordMs = 70; window.__micError = "";
  window.__spoken = []; window.__ttsMs = 40;
  window.__claude = []; window.__claudeNext = []; window.__badKeys = ["sk-ant-bad"];

  if (!cfg.noMic) {
    class FakeRecognition {
      start() {
        if (window.__micError || window.__micDown) {
          const error = window.__micError || window.__micDown; window.__micError = "";
          setTimeout(() => { this.onerror && this.onerror({ error }); this.onend && this.onend(); }, 20);
          return;
        }
        const [line, ...rest] = (window.__say.shift() || "").split(" | ");
        if (rest.length) window.__say.unshift(rest.join(" | "));
        const ws = line.split(" ").filter(Boolean), dropAfter = rest.length > 0;
        let i = 0; this.done = false;
        const tick = () => {
          if (this.done) return;
          i++;
          if (i <= ws.length) {
            const said = ws.slice(0, i).join(" "), last = i === ws.length;
            this.onresult && this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: said }], { isFinal: last })] });
          }
          if (i >= ws.length) {
            clearInterval(this.timer); // then silence until the app stops listening...
            if (dropAfter) setTimeout(() => { if (!this.done) { this.done = true; this.onend && this.onend(); } }, 80); // ...or the engine quits by itself
          }
        };
        this.timer = setInterval(tick, window.__wordMs);
      }
      stop() { if (this.done) return; this.done = true; clearInterval(this.timer); setTimeout(() => this.onend && this.onend(), 30); }
    }
    window.SpeechRecognition = window.webkitSpeechRecognition = FakeRecognition;
  } else {
    delete window.SpeechRecognition; delete window.webkitSpeechRecognition;
  }

  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  let speaking = [];
  Object.defineProperty(window, "speechSynthesis", { value: {
    getVoices: () => [{ name: "Samantha", lang: "en-US" }], onvoiceschanged: null,
    speak: (u) => { window.__spoken.push({ text: u.text, rate: u.rate }); const t = setTimeout(() => { speaking = speaking.filter((x) => x.u !== u); u.onend && u.onend(); }, window.__ttsMs); speaking.push({ u, t }); },
    cancel: () => { const s = speaking; speaking = []; s.forEach(({ u, t }) => { clearTimeout(t); u.onerror && u.onerror({ error: "interrupted" }); }); },
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
    const next = window.__claudeNext.shift() || {};
    window.__claude.push({ model: body.model, prompt, stream: body.stream, effort: body.output_config && body.output_config.effort, key, beta: headers.get("anthropic-beta") || "", fallbacks: body.fallbacks, outcome: Object.keys(next)[0] || "ok" });
    const json = (status, obj, extra) => new Response(JSON.stringify(obj), { status, headers: Object.assign({ "content-type": "application/json", "x-should-retry": "false" }, extra) });
    if (window.__badKeys.includes(key)) return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    if (next.offline || window.__offline) throw new TypeError("Failed to fetch");
    if (next.status) return json(next.status, { type: "error", error: { type: next.errorType || "api_error", message: "scripted failure" } });
    let parts;
    if (next.text != null) parts = [next.text];
    else if (prompt.includes("Reply with the single word: ready")) parts = ["ready"];
    else if (prompt.includes("Create today's English lesson")) parts = [JSON.stringify(cfg.lesson)];
    else if (prompt.includes("pronunciation coach")) parts = [JSON.stringify(cfg.coach)];
    else if (prompt.includes("giving feedback")) parts = cfg.feedback;
    else parts = ["(unexpected prompt)"];
    const ev = (type, data) => "event: " + type + "\ndata: " + JSON.stringify(Object.assign({ type }, data)) + "\n\n";
    const chunks = [ev("message_start", { message: { id: "msg_test", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } }),
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } })];
    if (!next.stopReason) parts.forEach((p) => chunks.push(ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: p } })));
    chunks.push(ev("content_block_stop", { index: 0 }), ev("message_delta", { delta: { stop_reason: next.stopReason || "end_turn", stop_sequence: null }, usage: { output_tokens: 100 } }), ev("message_stop", {}));
    const enc = new TextEncoder();
    const stream = new ReadableStream({ async start(c) { for (const ch of chunks) { c.enqueue(enc.encode(ch)); await new Promise((r) => setTimeout(r, 15)); } c.close(); } });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
  };
}

// ---------- checks and report ----------
export function createReport() {
  const results = [];
  return {
    results,
    check(name, ok, detail = "") { results.push({ name, ok: !!ok, detail }); console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok || !detail ? "" : "  → " + detail)); },
    section(title) { console.log("\n" + title); },
    finish() {
      const failed = results.filter((r) => !r.ok);
      console.log("\n" + (results.length - failed.length) + "/" + results.length + " checks passed");
      return failed.length ? 1 : 0;
    },
  };
}

// ---------- server and browser ----------
export async function startServer(port) {
  if (!existsSync(CHROME)) { console.error("Chrome not found. Set CHROME_PATH."); process.exit(2); }
  const server = await preview({ preview: { port, strictPort: true }, logLevel: "silent" });
  return { base: "http://localhost:" + port + "/", close: () => new Promise((r) => server.httpServer.close(r)) };
}

// A fresh browser profile (its own localStorage) with the stand-ins installed.
export async function openBrowser(cfg, opts = {}) {
  const profile = mkdtempSync(join(tmpdir(), "de-e2e-"));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ["--no-first-run", "--no-default-browser-check", "--window-size=1100,1000"], defaultViewport: { width: 1100, height: 1000 } });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !opts.ignoreConsole?.(m.text())) pageErrors.push(m.text()); });
  await page.evaluateOnNewDocument(standIns, cfg);
  return {
    browser, page, pageErrors, profile, h: helpers(page),
    async close() { await browser.close(); rmSync(profile, { recursive: true, force: true }); },
  };
}

export function helpers(page) {
  const h = {
    text: (sel) => page.$eval(sel, (e) => e.textContent.trim()),
    visible: (sel) => page.$eval(sel, (e) => !e.hidden && e.offsetParent !== null).catch(() => false),
    waitText: (sel, re, timeout = 15000) => page.waitForFunction((s, src) => { const e = document.querySelector(s); return e && new RegExp(src).test(e.textContent); }, { timeout }, sel, re.source),
    say: (...lines) => page.evaluate((ls) => { window.__say.push(...ls); }, lines),
    plan: () => page.$$eval(".step", (els) => els.map((e) => ({ done: e.classList.contains("done"), text: e.textContent }))),
    clickText: (sel, label) => page.evaluate((s, l) => { const b = [...document.querySelectorAll(s)].find((x) => x.textContent.trim() === l); if (!b) throw new Error("no button " + l); b.click(); }, sel, label),
    spoken: () => page.evaluate(() => window.__spoken.slice()),
    clearSpoken: () => page.evaluate(() => { window.__spoken.length = 0; }),
    claude: () => page.evaluate(() => window.__claude.slice()),
    active: () => page.$$eval(".sent", (els) => els.findIndex((e) => e.classList.contains("active"))),
    scores: () => page.$$eval(".sent .score", (els) => els.map((e) => (e.hidden ? "" : e.textContent))),
    pause: (ms) => new Promise((r) => setTimeout(r, ms)),
    // Waits until no take is open: the Read button is back to "Read".
    readIdle: (timeout = 20000) => page.waitForFunction(() => document.getElementById("r-read").textContent.trim() === "Read", { timeout }),
  };
  return h;
}
