// End-to-end drill of every feature of the app, beyond the daily flow covered by session.mjs:
// reader controls and keyboard, Play story, Hands-free / Listen first / Slow voice, manual stop,
// silence, a recognizer that closes by itself, Chrome speech errors, Read again, tapping words,
// word practice, vocabulary and focus, exercises, Speak freely, Review with spaced repetition,
// Progress, every Settings control, Claude errors and model choice, backup export and import,
// history and streaks, automatic lessons, dark mode, phone width and offline start.
// Same stand-ins as session.mjs (fake microphone, voice and Claude); nothing real is opened.
// Run: npm run test:e2e
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, openBrowser, createReport } from "./harness.mjs";
import { dateKey, addDays } from "../../src/core/text.js";

const STARTER = JSON.parse(readFileSync(new URL("../../src/lessons/starter.json", import.meta.url)));
const S = STARTER.sentences;
const TODAY = dateKey(new Date()), Y1 = addDays(TODAY, -1), Y2 = addDays(TODAY, -2);

const LESSON = {
  title: "The Quiet Release", level: "C1 + C2 words", topic: "work",
  sentences: [
    "Our release went out on Monday without a single alert.",
    "The team celebrated quietly because nobody trusted the silence yet.",
    "By Friday the dashboards proved that the fix was genuinely robust.",
  ],
  vocab: [{ word: "robust", inStory: "robust", ipa: "/roʊˈbʌst/", say: "rou-BAST", pos: "adjective", level: "C1", meaning: "strong and reliable", es: "robusto", example: "We need a robust test suite." }],
  focus: { title: "Past tense -ed", tip: "Pronuncia la terminación -ed.", items: [{ text: "celebrated", note: "/ˈsɛləbreɪtɪd/ final -id" }] },
  drills: [{ prompt: "By Friday the fix was genuinely ____.", options: ["robust", "fragile", "silent", "late"], answer: "robust", why: "Robust means strong and reliable." }],
  speak: "Tell me about a release at work that went better than you expected.",
  sentencesEs: ["Nuestro lanzamiento salió el lunes sin una sola alerta.", "El equipo lo celebró en silencio porque nadie confiaba todavía en la calma.", "Para el viernes, los paneles demostraron que el arreglo era realmente robusto."],
};
const COACH = { celebrated: { ipa: "/ˈsɛləbreɪtɪd/", say: "SE-le-brei-tid", tip: "Pronuncia la -ed como una sílaba extra: -id.", pair: "celebrate / celebrated", examples: ["We celebrated the launch.", "They celebrated quietly.", "She celebrated her promotion."], examplesEs: ["Celebramos el lanzamiento.", "Lo celebraron en silencio.", "Ella celebró su ascenso."] } };
const FEEDBACK = ["You answered clearly.\n", "Corrections:\n", "I think the story is about -> I think the story is about (bien)\n", "Repeat: The story is about patience."];
const cfg = { lesson: LESSON, coach: COACH, feedback: FEEDBACK };

// A backup from someone who practiced the two previous days (for history, streak and review).
const YESTERDAY_LESSON = {
  title: "Coffee Before Standup", level: "C1 + C2 words", topic: "life", date: Y1, source: "app",
  sentences: ["I made coffee before the morning standup.", "The meeting was short and surprisingly candid.", "Everyone agreed to test the change thoroughly."],
  vocab: [{ word: "candid", inStory: "candid", meaning: "honest and direct" }], drills: [], speak: "How do your meetings usually go?",
};
const vocabDoc = (word, meaning, due, step) => ({ word, meaning, ipa: "", say: "", es: "", example: "", level: "C1", pos: "adjective", added: Y2, due, step });
const BACKUP = {
  app: "daily-english", version: 1, exportedAt: new Date().toISOString(),
  data: {
    lessons: { [Y1]: YESTERDAY_LESSON },
    sessions: {
      [Y2]: { date: Y2, lesson: Y2, title: "Older story", reads: {}, missed: [], drills: {}, speak: "", accuracy: 80, updatedAt: Y2 + "T10:00:00.000Z" },
      [Y1]: { date: Y1, lesson: Y1, title: YESTERDAY_LESSON.title, reads: {}, missed: [], drills: {}, speak: "", accuracy: 90, updatedAt: Y1 + "T10:00:00.000Z" },
    },
    vocab: { candid: vocabDoc("candid", "honest and direct", Y1, 0), resilient: vocabDoc("resilient", "recovers quickly", TODAY, 1), meticulous: vocabDoc("meticulous", "very careful", addDays(TODAY, 5), 2) },
    words: { thorough: { word: "thorough", misses: 3, hits: 1, last: Y1, heardAs: "through" } },
  },
};

const { check, section, finish } = createReport();
const server = await startServer(4320);
const base = server.base;
const files = mkdtempSync(join(tmpdir(), "de-e2e-files-"));

// ---------- A. A browser without speech recognition ----------
{
  const { page, pageErrors, h, close } = await openBrowser(Object.assign({ noMic: true }, cfg));
  try {
    section("A. A browser without speech recognition");
    await page.goto(base + "#today", { waitUntil: "networkidle0" }); await page.waitForSelector(".sent");
    await page.click("#status-close");
    await page.click("#r-read");
    check("Read explains that speech recognition needs Chrome or the Mac app", /open the app in Google Chrome/.test(await h.text("#status-text")));
    await page.click("#r-listen"); await h.pause(150);
    check("Listen still works", (await h.spoken()).some((u) => u.text === S[0]));
    await page.goto(base + "#settings"); await page.waitForSelector("#dev-info li");
    check("Settings says the microphone is not available", /Microphone \(speech recognition\): not available/.test(await h.text("#dev-info")));
    check("no errors in the page", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  } catch (e) { check("part A ran to the end", false, e.message); } finally { await close(); }
}

// ---------- B to C. One learner, from first launch to backups ----------
{
  const { browser, page, pageErrors, h, close } = await openBrowser(cfg);
  const { text, visible, waitText, say, plan, clickText, spoken, clearSpoken, claude, active, scores, pause, readIdle } = h;
  const setW = (patch) => page.evaluate((p) => Object.assign(window, p), patch);
  const blur = () => page.evaluate(() => document.activeElement && document.activeElement.blur());
  const pick = (i) => page.$eval("#sentences .sent:nth-child(" + (i + 1) + ")", (e) => e.click());
  const sentClass = (i, cls) => page.$$eval("#sentences .sent:nth-child(" + (i + 1) + ") .tok." + cls, (els) => els.map((e) => e.textContent));
  const scoreOf = async (i) => (await scores())[i];
  const waitScore = (i, timeout = 20000) => page.waitForFunction((k) => { const s = document.querySelectorAll(".sent .score")[k]; return s && !s.hidden; }, { timeout }, i);
  const readOne = async (i, line) => { await pick(i); await say(line); await page.click("#r-read"); await waitScore(i); await readIdle(); };
  try { await browser.defaultBrowserContext().overridePermissions(base, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]); } catch (e) { /* older Chrome: the app falls back to selecting the text */ }

  try {
    section("B1. First launch without an API key");
    await page.goto(base + "#today", { waitUntil: "networkidle0" }); await page.waitForSelector(".sent");
    check("the starter story is labeled as such", /Starter story/.test(await text("#lesson-kicker")));
    check("the note links to Settings", (await text("#status-action")) === "Open Settings" && (await page.$eval("#status-action", (a) => a.getAttribute("href"))) === "#settings");
    check("AI buttons are off and say why", await page.$eval("#coach-btn", (b) => b.disabled && b.title === "Add your API key in Settings") && await page.$eval("#speak-fb", (b) => b.disabled));
    check("'Create today's story' is hidden without a key", !(await visible("#make-lesson")));
    check("the story's vocabulary words are highlighted", (await page.$$(".tok.vocab")).length >= STARTER.vocab.length);
    await page.click("#status-close");
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".sent");
    check("a closed note stays closed after reopening", !(await visible("#status")));
    await page.goto(base + "#nope"); await pause(100);
    check("an unknown address opens Today", await page.$eval("#view-today", (v) => v.classList.contains("on")));

    section("B2. Reading settings");
    await page.goto(base + "#settings"); await page.waitForSelector("#set-pause");
    await page.select("#set-pause", "short");
    await page.click("#set-expect"); // off
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector("#set-pause");
    check("pause length is remembered", (await page.$eval("#set-pause", (s) => s.value)) === "short");
    check("'expected words' is remembered", (await page.$eval("#set-expect", (c) => c.checked)) === false);
    await page.click("#set-expect"); // back on

    section("B3. Moving through the story");
    await page.goto(base + "#today"); await page.waitForSelector(".sent.active");
    check("the reading bar starts at sentence 1", (await text("#reader-pos")) === "Sentence 1 of " + S.length && await page.$eval("#r-prev", (b) => b.disabled));
    await page.click("#r-next");
    check("Next moves to sentence 2", (await active()) === 1 && /Sentence 2 of/.test(await text("#reader-pos")));
    await blur(); await page.keyboard.press("ArrowRight");
    check("→ moves forward", (await active()) === 2);
    await page.keyboard.press("ArrowLeft");
    check("← moves back", (await active()) === 1);
    await pick(S.length - 1);
    check("tapping a sentence selects it; Next is off at the end", (await active()) === S.length - 1 && await page.$eval("#r-next", (b) => b.disabled));
    await pick(0); await clearSpoken();
    await page.$eval("#sentences .sent:nth-child(1) .tok", (t) => t.click()); await pause(150);
    const word = (await spoken())[0];
    check("tapping a word says it, slowly", word && word.text === S[0].split(" ")[0] && word.rate === 0.8, JSON.stringify(word));
    await clearSpoken(); await blur(); await page.keyboard.press("l"); await pause(150);
    check("L plays the sentence at normal speed", (await spoken()).some((u) => u.text === S[0] && u.rate === 1));
    await page.click("#opt-slow"); await clearSpoken(); await page.click("#r-listen"); await pause(150);
    check("Slow voice plays it at 0.75", (await spoken()).some((u) => u.text === S[0] && u.rate === 0.75));
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".sent");
    check("Slow voice is remembered", await page.$eval("#opt-slow", (c) => c.checked));
    await page.click("#opt-slow");

    section("B4. Play story");
    await pick(S.length - 3); await clearSpoken();
    await page.click("#play-story");
    check("the button turns into Stop", (await text("#play-story")) === "Stop");
    await waitText("#play-story", /Play story/);
    check("it plays from the selected sentence to the end, in order", JSON.stringify((await spoken()).map((u) => u.text)) === JSON.stringify(S.slice(-3)));
    check("the last sentence ends up selected", (await active()) === S.length - 1);
    await setW({ __ttsMs: 800 }); await pick(S.length - 3); await clearSpoken();
    await page.click("#play-story"); await pause(300); await page.click("#play-story");
    await pause(1000);
    check("Stop ends it after the current sentence", (await spoken()).length === 1 && (await text("#play-story")) === "Play story" && (await active()) === S.length - 3);
    await setW({ __ttsMs: 40 });

    section("B5. Hands-free reading, then silence");
    await pick(0); await say(S[0], S[1]);
    await page.click("#r-read");
    await waitText("#sentences .sent:nth-child(3) .sent-live", /Nothing was heard/, 25000);
    await readIdle();
    const sc = await scores();
    check("two sentences read in a row are both 100%", sc[0] === "100%" && sc[1] === "100%", sc.slice(0, 3).join(" "));
    check("the third, with nothing said, closes by itself and says so", sc[2] === "");
    check("the plan counts 2 read", /2\/11/.test((await plan())[0].text));

    section("B6. Hands-free off");
    await page.click("#opt-handsfree");
    await say(S[2]); await page.click("#r-read"); await waitScore(2); await pause(1500);
    check("after one sentence the next is selected but not recorded", (await active()) === 3 && (await text("#r-read")) === "Read" && !/Listening/.test(await text("#sentences .sent:nth-child(4) .sent-live")));

    section("B7. Stopping by hand (Space) in the middle");
    await setW({ __wordMs: 250 }); await say(S[3]);
    await blur(); await page.keyboard.press("Space"); await pause(1400); await page.keyboard.press("Space");
    check("the button says Checking… while closing", /Checking…|Read/.test(await text("#r-read")));
    await waitScore(3); await readIdle(); await setW({ __wordMs: 70 });
    const ok3 = await sentClass(3, "ok"), miss3 = await sentClass(3, "miss");
    check("the words said are green and the rest red", ok3.length >= 2 && miss3.length >= 8 && miss3.includes(S[3].split(" ").pop()), ok3.length + " ok / " + miss3.length + " red");
    check("Tap a red word hint is shown", /Tap a red word/.test(await text("#sentences .sent:nth-child(4) .sent-actions")));

    section("B8. Read again");
    await say(S[3]);
    await page.$eval("#sentences .sent:nth-child(4) .sent-actions button", (b) => b.click());
    await page.waitForFunction(() => document.querySelectorAll(".sent .score")[3].textContent === "100%", { timeout: 20000 }); await readIdle();
    check("reading again replaces the result", (await sentClass(3, "miss")).length === 0);

    section("B9. The recognizer closes by itself mid-sentence");
    const half = S[4].split(" "), cut = Math.floor(half.length / 2);
    await readOne(4, half.slice(0, cut).join(" ") + " | " + half.slice(cut).join(" "));
    check("the app reopens it and keeps the first half: 100%", (await scoreOf(4)) === "100%", await scoreOf(4));

    section("B10. Listen first");
    await page.click("#opt-listenfirst"); await setW({ __ttsMs: 600 }); await clearSpoken();
    await pick(5); await say(S[5]); await page.click("#r-read");
    await waitText("#r-read", /Listen…/, 2000);
    check("the model plays first and the button says Listen…", true);
    await waitScore(5); await readIdle();
    check("then the sentence is recorded: 100%", (await scoreOf(5)) === "100%" && (await spoken())[0].text === S[5]);
    await page.click("#opt-listenfirst"); await setW({ __ttsMs: 40 });

    section("B11. Chrome speech recognition without internet");
    await pick(6); await setW({ __micDown: "network" }); await page.click("#r-read");
    await waitText("#status-text", /needs an internet connection/, 8000);
    await readIdle();
    check("after a few quick retries the reason is shown and nothing is graded", (await scoreOf(6)) === "");
    await setW({ __micDown: "" });

    section("B12. Leaving Today while recording");
    await setW({ __wordMs: 400 }); await say(S[6]); await page.click("#r-read"); await pause(700);
    await page.click('nav.tabs a[data-tab="review"]'); await pause(400);
    await page.click('nav.tabs a[data-tab="today"]'); await pause(300);
    check("the take is cancelled, not graded", (await scoreOf(6)) === "" && (await text("#r-read")) === "Read");
    await setW({ __wordMs: 70, __say: [] });

    section("B13. A mispronounced word");
    await readOne(6, S[6].replace("cryptic", "critic"));
    check("only that word is red", JSON.stringify(await sentClass(6, "miss")) === JSON.stringify(["cryptic"]));
    await pick(6); await clearSpoken();
    await page.$eval("#sentences .sent:nth-child(7) .tok.miss", (t) => t.click()); await pause(150);
    check("tapping the red word says it", (await spoken()).some((u) => u.text === "cryptic" && u.rate === 0.8));

    section("B14. Practicing a word (Fix words)");
    check("the word lists what was heard", /heard as “critic”/.test(await text("#fix-list")));
    const rowBtn = (w, label) => page.evaluate((w, l) => { const r = [...document.querySelectorAll("#fix-list .wordrow")].find((x) => x.querySelector(".vword").textContent === w); [...r.querySelectorAll("button")].find((b) => b.textContent.trim() === l).click(); }, w, label);
    await clearSpoken(); await rowBtn("cryptic", "Listen"); await pause(150);
    check("Listen says the word slowly", (await spoken()).some((u) => u.text === "cryptic" && u.rate === 0.8));
    await say("critic"); await rowBtn("cryptic", "Say it"); await pause(300); await rowBtn("cryptic", "Stop");
    await waitText("#fix-list", /Heard “critic”/);
    check("a wrong try asks to listen and retry", true);
    await say("cryptic"); await rowBtn("cryptic", "Say it"); await pause(300); await rowBtn("cryptic", "Stop");
    await waitText("#fix-list", /Understood: “cryptic”/);
    check("a right try is confirmed", true);

    section("B15. Vocabulary and pronunciation focus");
    await clearSpoken();
    await page.$eval("#vocab .vcard button", (b) => b.click()); await pause(150);
    const v0 = STARTER.vocab[0];
    const said = (await spoken()).map((u) => u.text + "@" + u.rate);
    check("a vocabulary card says the word, then its example", said[0] === v0.word + ".@0.9" && said[1] === v0.example + "@0.9", said.join(" | "));
    await page.$eval("#focus-items .vcard button", (b) => b.click()); await pause(150);
    check("a focus item is spoken slowly", (await spoken()).some((u) => u.text === STARTER.focus.items[0].text && u.rate === 0.8));

    section("B15b. Explanations and examples in Spanish");
    await page.goto(base + "#today"); await page.waitForSelector(".sent.active");
    await pick(0);
    check("the Español switch is on by default", await visible("#opt-es-wrap") && await page.$eval("#opt-es", (c) => c.checked));
    check("the sentence being read shows its Spanish translation", (await text(".sent.active .sent-es")) === STARTER.sentencesEs[0] && await visible(".sent.active .sent-es"));
    check("only the active sentence shows it", (await page.$$eval(".sent-es", (els) => els.filter((e) => e.offsetParent !== null).length)) === 1);
    check("translations are marked as Spanish", await page.$eval(".sent.active .sent-es", (e) => e.lang === "es"));
    await page.click("#opt-es");
    check("the switch hides it", !(await visible(".sent.active .sent-es")));
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".sent.active");
    check("and is remembered", !(await page.$eval("#opt-es", (c) => c.checked)) && !(await visible(".sent.active .sent-es")));
    await page.click("#opt-es");
    const card0 = await text("#vocab .vcard");
    check("vocabulary cards explain the word in Spanish", card0.includes(v0.noteEs));
    check("and translate the example", card0.includes(v0.exampleEs));
    check("Speak freely gives help in Spanish with useful phrases", (await text("#speak-es")) === STARTER.speakHelpEs);

    section("B16. Exercises, all correct");
    for (let i = 0; i < STARTER.drills.length; i++) await clickText("#drills .drill:nth-child(" + (i + 1) + ") button", STARTER.drills[i].answer);
    check("each answer is explained in Spanish", (await page.$$eval("#drills .drill .es", (els) => els.map((e) => e.textContent))).join("|") === STARTER.drills.map((d) => d.whyEs).join("|"));
    check("the chip shows a perfect score", (await text("#drill-chip")) === STARTER.drills.length + "/" + STARTER.drills.length + " correct" && await page.$eval("#drill-chip", (c) => c.classList.contains("good")));
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".sent");
    check("answers stay locked after reopening", (await page.$$("#drills button.right")).length === STARTER.drills.length && (await page.$$("#drills button:not([disabled])")).length === 0);

    section("B17. The plan jumps to each part");
    await page.$$eval(".step", (els) => els[3].click()); await pause(200);
    check("Speak freely gets the focus", await page.evaluate(() => document.activeElement.id) === "speak-card");

    section("B18. Speak freely without a key");
    await say("I think the story is about patience");
    await page.click("#speak-rec"); await pause(800); await page.click("#speak-rec");
    await waitText("#speak-text", /patience/);
    check("what was said is kept", (await text("#speak-text")) === "I think the story is about patience");
    await page.click("#speak-rec"); await pause(200); await page.click("#speak-rec");
    await waitText("#speak-live", /Nothing was heard/);
    check("an empty try adds nothing", (await text("#speak-text")) === "I think the story is about patience");
    check("feedback needs a key", await page.$eval("#speak-fb", (b) => b.disabled));

    section("B19. Review");
    await page.goto(base + "#review"); await page.waitForSelector("#due-chip");
    check("new words are not due until tomorrow", (await text("#due-chip")) === "0 due" && await visible("#due-empty"));
    check("difficult words are listed", (await page.$$("#hard-list .wordrow")).length > 0 && !(await visible("#hard-empty")));
    check("a word said well is not listed as difficult", !(await page.$$eval("#hard-list .vword", (els) => els.map((e) => e.textContent))).includes("cryptic"));

    section("B20. Progress");
    await page.goto(base + "#progress"); await page.waitForSelector("#bars");
    const acc = (await page.evaluate(() => JSON.parse(localStorage.getItem("de:sessions")))) [TODAY].accuracy;
    check("today counts as a practiced day", (await text("#st-days")) === "1" && (await text("#st-streak")) === "1");
    check("average accuracy matches today's", (await text("#st-acc")) === acc + "%", (await text("#st-acc")) + " vs " + acc);
    check("words in review = the story's vocabulary", (await text("#st-vocab")) === String(STARTER.vocab.length));
    check("missed words table shows tries", /cryptic/.test(await text("#miss-table")) && (await page.$$("#bars .bar")).length === 1);

    section("B21. Microphone log");
    // The log lives in memory (it starts over when the app reopens), so make a take with a restart now.
    await page.goto(base + "#today"); await page.waitForSelector(".sent");
    const s7 = S[7].split(" ");
    await readOne(7, s7.slice(0, 6).join(" ") + " | " + s7.slice(6).join(" "));
    await page.goto(base + "#settings"); await page.waitForSelector("#log-copy");
    await page.$eval("details.trouble", (d) => { d.open = true; });
    await page.click("#log-copy");
    await waitText("#log-msg", /Copied|Selected/);
    const log = await page.$eval("#log-text", (t) => t.value);
    check("the log can be copied", /Copied|Selected/.test(await text("#log-msg")) && !(await page.$eval("#log-text", (t) => t.hidden)));
    check("it records each take and the recognizer restart", /app start take/.test(log) && /RESTART/.test(log) && /app take closed/.test(log), log.split("\n").filter((l) => /RESTART|start take|take closed/.test(l)).slice(0, 4).join(" || ") + " [" + log.split("\n").length + " lines]");

    section("C1. Settings: model and automatic story");
    const hit = await page.$eval("#set-test", (b) => { b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return t === b || b.contains(t) ? "ok" : (t ? t.tagName + "#" + t.id + "." + t.className : "none"); });
    check("the Test button is not covered by anything", hit === "ok", hit);
    await page.click("#set-test");
    check("testing without a key asks for one", (await text("#set-msg")) === "Enter an API key first.", await text("#set-msg") + " / key=" + await page.$eval("#set-key", (e) => e.value));
    await page.type("#set-key", "sk-ant-test-0000");
    await page.select("#set-model", "claude-sonnet-5-5");
    await page.click("#set-auto"); // off
    await page.click("#set-save"); await waitText("#set-msg", /Saved/);
    check("Claude shows as connected with the chosen model", (await text("#ai-chip")) === "Connected" && /connected with claude-sonnet-5-5/.test(await text("#dev-info")));
    await page.goto(base + "#today"); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".sent");
    check("with automatic stories off, it offers to create today's story", /not ready yet/.test(await text("#status-text")) && await visible("#make-lesson"));
    check("no story was requested by itself", (await claude()).length === 0);

    section("C2. Claude errors when creating the story");
    const failures = [
      [{ status: 429, errorType: "rate_limit_error" }, /Too many requests/],
      [{ text: "Sorry, here is your lesson without JSON." }, /could not be read/],
      [{ status: 529, errorType: "overloaded_error" }, /Claude is busy right now/],
      [{ status: 500, errorType: "api_error" }, /Claude had a problem/],
      [{ status: 403, errorType: "permission_error" }, /cannot use the chosen model/],
      [{ status: 404, errorType: "not_found_error" }, /not available for this key/],
    ];
    for (const [next, re] of failures) {
      await setW({ __claudeNext: [next] });
      await page.click("#make-lesson");
      await waitText("#status-text", re);
      await page.waitForFunction(() => { const b = document.getElementById("make-lesson"); return !b.disabled && /Create today/.test(b.textContent); });
      check("explained: " + re.source.replace(/\\/g, ""), true);
    }
    await page.click("#make-lesson");
    await waitText("#lesson-title", /The Quiet Release/, 20000);
    check("then it works: today's story replaces the starter", /Today's story/.test(await text("#lesson-kicker")) && (await page.$$(".sent")).length === 3 && !(await visible("#make-lesson")));
    const made = (await claude()).filter((c) => c.prompt.includes("Create today's English lesson")).pop();
    check("the request uses the chosen model, with fallbacks", made.model === "claude-sonnet-5-5" && /server-side-fallback-2026-07-01/.test(made.beta) && made.fallbacks === "default");
    check("the request asks for translations and explanations in Spanish", ["sentencesEs", "noteEs", "exampleEs", "whyEs", "speakHelpEs"].every((f) => made.prompt.includes(f)));
    check("the request asks to reuse the learner's difficult words", /Reuse some of the learner's difficult words if natural: (?!none)/.test(made.prompt));

    section("C3. Coaching with no connection, then with Haiku");
    await page.click("#opt-handsfree"); // back on
    await pick(0); await say(LESSON.sentences[0], LESSON.sentences[1].replace("celebrated", "celebrate"), LESSON.sentences[2]);
    await page.click("#r-read");
    await page.waitForFunction(() => !document.getElementById("story-done").hidden, { timeout: 30000 });
    check("hands-free read all three sentences", (await scores()).every((s) => s));
    await page.goto(base + "#settings"); await page.waitForSelector("#set-model");
    await page.select("#set-model", "claude-haiku-5-5"); await page.click("#set-save"); await waitText("#set-msg", /Saved/);
    await page.goto(base + "#today"); await page.waitForSelector("#coach-btn:not([disabled])");
    await setW({ __offline: true });
    await page.click("#coach-btn");
    await waitText("#status-text", /No connection to Claude/, 20000);
    check("no connection is explained and the button comes back", await page.$eval("#coach-btn", (b) => !b.disabled));
    await setW({ __offline: false });
    await page.click("#coach-btn");
    await waitText("#fix-list", /sílaba extra/);
    const coachCall = (await claude()).filter((c) => c.prompt.includes("pronunciation coach")).pop();
    check("coaching uses Haiku without fallbacks (Haiku does not take them)", coachCall.model === "claude-haiku-5-5" && !/server-side-fallback/.test(coachCall.beta) && coachCall.fallbacks === undefined);
    check("the button says the coaching is ready", (await text("#coach-btn")) === "Coaching ready");
    await clearSpoken(); await page.evaluate(() => [...document.querySelectorAll("#fix-list .row button")].find((b) => b.textContent === "celebrate").click()); await pause(150);
    check("the contrast pair is playable", (await spoken()).some((u) => u.text === "celebrate"));
    await page.evaluate(() => document.querySelector("#fix-list li.ex").click()); await pause(150);
    check("the example sentences are playable", (await spoken()).some((u) => u.text === COACH.celebrated.examples[0]));
    const fixText = await text("#fix-list");
    check("coaching examples come with their Spanish translation", COACH.celebrated.examplesEs.every((t) => fixText.includes(t)));
    check("Claude's story brings its Spanish translation", (await text(".sent.active .sent-es")).length > 0 && LESSON.sentencesEs.includes(await text(".sent.active .sent-es")));

    section("C4. Feedback that Claude declines, then a retry");
    await say("I think the story is about patience"); await page.click("#speak-rec"); await pause(800); await page.click("#speak-rec");
    await waitText("#speak-text", /patience/);
    await setW({ __claudeNext: [{ stopReason: "refusal" }] });
    await page.click("#speak-fb"); await waitText("#speak-feedback", /declined/);
    check("a refusal is explained", await page.$eval("#speak-fb", (b) => !b.disabled));
    await page.click("#speak-fb"); await waitText("#speak-feedback", /Repeat:/);
    check("retrying gives the feedback", /You answered clearly/.test(await text("#speak-feedback")));

    section("C5. Backup");
    const cdp = await page.createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: files });
    await page.goto(base + "#settings"); await page.waitForSelector("#exp-btn");
    await page.click("#exp-btn"); await waitText("#data-msg", /Backup ready/);
    let saved = null;
    for (let i = 0; i < 50 && !saved; i++) { saved = readdirSync(files).find((f) => f === "daily-english-backup-" + TODAY + ".json"); if (!saved) await pause(100); }
    const raw = saved ? readFileSync(join(files, saved), "utf8") : "";
    const backup = raw ? JSON.parse(raw) : {};
    check("the backup file is downloaded with today's date", !!saved);
    check("it has today's story, session, words and vocabulary", backup.app === "daily-english" && backup.data.lessons[TODAY] && backup.data.sessions[TODAY] && backup.data.words.celebrated && backup.data.vocab.robust);
    check("it does not contain the API key", raw && !raw.includes("sk-ant"));
    writeFileSync(join(files, "not-a-backup.json"), "{}");
    await (await page.$("#imp-file")).uploadFile(join(files, "not-a-backup.json"));
    await waitText("#data-msg", /not a Daily English backup/);
    check("a wrong file is refused", true);

    section("C6. Removing the key");
    await page.$eval("#set-key", (e) => { e.value = ""; }); await page.click("#set-save");
    await waitText("#set-msg", /Without an API key/);
    check("the app says what still works", (await text("#ai-chip")) === "No API key");
    await page.goto(base + "#today"); await page.waitForSelector(".sent");
    check("AI buttons are off again", await page.$eval("#speak-fb", (b) => b.disabled && b.title === "Add your API key in Settings"));

    section("C7. Dark mode and phone width");
    const bg = () => page.evaluate(() => { const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    const light = await bg();
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    const dark = await bg();
    check("the page follows the system's dark mode", light > 0.8 && dark < 0.2, light.toFixed(2) + " / " + dark.toFixed(2));
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const wide = [];
    for (const tab of ["today", "review", "progress", "settings"]) {
      await page.goto(base + "#" + tab); await pause(250);
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      if (w > 390) wide.push(tab + " " + w);
    }
    check("no tab scrolls sideways on a phone", wide.length === 0, wide.join(", "));
    await page.goto(base + "#today"); await pause(250);
    check("the reading bar stays on screen on a phone", await page.evaluate(() => { const r = document.getElementById("reader").getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top < innerHeight; }));
    await page.emulateMediaFeatures([]); await page.setViewport({ width: 1100, height: 1000 });

    section("C8. Opening the app with no internet");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.reload({ waitUntil: "networkidle0" }); // now every file goes through the offline cache
    const before = pageErrors.length;
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sent", { timeout: 10000 });
    check("the app opens offline with today's story and results", (await text("#lesson-title")) === LESSON.title && (await page.$$(".sent .score:not([hidden])")).length === 3);
    await page.setOfflineMode(false);
    pageErrors.splice(before); // the browser logs the failed network requests while offline

    check("no errors in the page", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  } catch (e) {
    check("parts B and C ran to the end", false, e.message);
    await page.screenshot({ path: join(tmpdir(), "de-e2e-features-failure.png") }).catch(() => {});
    console.log("  screenshot: " + join(tmpdir(), "de-e2e-features-failure.png"));
  } finally { await close(); }
}

// ---------- D. Another device: importing history ----------
{
  const { page, pageErrors, h, close } = await openBrowser(cfg);
  const { text, visible, waitText, pause, claude } = h;
  const stored = (col) => page.evaluate((c) => JSON.parse(localStorage.getItem("de:" + c) || "{}"), col);
  try {
    section("D1. Importing a backup with two earlier days");
    await page.goto(base + "#settings", { waitUntil: "networkidle0" }); await page.waitForSelector("#imp-file");
    writeFileSync(join(files, "history.json"), JSON.stringify(BACKUP));
    await (await page.$("#imp-file")).uploadFile(join(files, "history.json"));
    await waitText("#data-msg", /Imported 7 records/);
    check("all records are imported", true);
    await page.goto(base + "#today"); await page.waitForSelector(".sent");
    check("the latest story is shown with its date", (await text("#lesson-title")) === YESTERDAY_LESSON.title && (await text("#lesson-kicker")).includes("Latest story, " + Y1));
    check("a story without Spanish hides the Español switch", !(await visible("#opt-es-wrap")) && (await page.$$eval(".sent-es", (els) => els.every((e) => e.hidden))));
    check("the streak counts yesterday and the day before", (await text("#streak")) === "2-day streak");

    section("D2. Spaced review");
    await page.goto(base + "#review"); await page.waitForSelector("#due-chip");
    check("two words are due (one overdue, one today)", (await text("#due-chip")) === "2 due");
    check("the overdue word comes first", (await page.$eval("#due-list .vcard .vword", (e) => e.textContent)) === "candid");
    check("the meaning is hidden until asked", await page.$eval("#due-list .vcard", (c) => c.querySelector(".small").closest("div[hidden]") !== null));
    await h.clickText("#due-list .vcard:nth-child(1) button", "Show meaning");
    await h.clickText("#due-list .vcard:nth-child(1) button", "I knew it");
    check("knowing it removes it from today", (await text("#due-chip")) === "1 due");
    await h.clickText("#due-list .vcard:nth-child(1) button", "Show meaning");
    await h.clickText("#due-list .vcard:nth-child(1) button", "Again tomorrow");
    check("nothing left to review", (await text("#due-chip")) === "0 due" && await visible("#due-empty"));
    const v = await stored("vocab");
    check("a known word comes back in 3 days", v.candid.step === 1 && v.candid.due === addDays(TODAY, 3) && v.candid.lastReview === TODAY, JSON.stringify(v.candid));
    check("a missed word comes back tomorrow", v.resilient.step === 0 && v.resilient.due === addDays(TODAY, 1), JSON.stringify(v.resilient));
    check("a word not due yet is untouched", v.meticulous.due === addDays(TODAY, 5));
    check("imported difficult words are listed", /thorough/.test(await text("#hard-list")));

    section("D3. Progress with history");
    await page.goto(base + "#progress"); await page.waitForSelector("#bars");
    check("two days, 85% on average", (await text("#st-days")) === "2" && (await text("#st-acc")) === "85%");
    check("words in review include the starter's and the imported ones", (await text("#st-vocab")) === String(STARTER.vocab.length + 3));
    check("one bar per day, newest first", JSON.stringify(await page.$$eval("#bars .bar span:first-child", (els) => els.map((e) => e.textContent))) === JSON.stringify([Y1, Y2]));
    check("the missed-words table has the imported word", /thorough\s*3\s*1/.test((await text("#miss-table")).replace(/\s+/g, " ")) || /thorough/.test(await text("#miss-table")));

    section("D4. Practicing today keeps the streak going");
    await page.goto(base + "#today"); await page.waitForSelector(".sent");
    await page.click("#opt-handsfree"); // read one sentence only
    await h.say(YESTERDAY_LESSON.sentences[0]); await page.click("#r-read");
    await page.waitForFunction(() => !document.querySelector(".sent .score").hidden, { timeout: 20000 });
    check("the streak becomes 3 days", (await text("#streak")) === "3-day streak");

    section("D5. Automatic story when the app opens");
    await page.goto(base + "#settings"); await page.waitForSelector("#set-key");
    check("automatic stories are on by default", await page.$eval("#set-auto", (c) => c.checked));
    await page.type("#set-key", "sk-ant-test-0000"); await page.click("#set-save"); await waitText("#set-msg", /Saved/);
    await page.goto(base + "#today"); await page.reload({ waitUntil: "networkidle0" });
    await waitText("#lesson-title", /The Quiet Release/, 20000);
    check("opening the app creates today's story by itself", /Today's story/.test(await text("#lesson-kicker")));
    const req = (await claude()).find((c) => c.prompt.includes("Create today's English lesson"));
    check("it avoids repeating recent stories and reuses difficult words", req.prompt.includes("avoid these recent titles: " + YESTERDAY_LESSON.title) && req.prompt.includes("thorough"));
    check("it uses the default model, Opus 5.5", req.model === "claude-opus-5-5");
    check("the streak and history are kept", (await text("#streak")) === "3-day streak");
    check("no errors in the page", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  } catch (e) {
    check("part D ran to the end", false, e.message);
    await page.screenshot({ path: join(tmpdir(), "de-e2e-history-failure.png") }).catch(() => {});
    console.log("  screenshot: " + join(tmpdir(), "de-e2e-history-failure.png"));
  } finally { await close(); }
}

await server.close();
rmSync(files, { recursive: true, force: true });
process.exit(finish());
