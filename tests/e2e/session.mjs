// End-to-end drill of a whole practice day, including a spoken conversation with Claude.
// Runs the real built app in headless Chrome with three stand-ins:
//   - a fake microphone (Web Speech API) that "says" scripted lines,
//   - a fake voice (speech synthesis) that finishes instantly,
//   - a fake Claude: calls to api.anthropic.com are answered in the page with streamed replies.
// Nothing is sent over the network and the real microphone is never opened.
// Run: npm run test:e2e
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, openBrowser, createReport } from "./harness.mjs";

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

// ---------- runner ----------
const { check, finish } = createReport();
const transcript = [];
const server = await startServer(4319);
const base = server.base;
const { page, pageErrors, h, close } = await openBrowser({ lesson: LESSON, coach: COACH, feedback: FEEDBACK });
const { text, visible, waitText, say, plan, clickText } = h;

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
  await page.evaluate(() => { window.__micError = "not-allowed"; });
  await page.goto(base + "#today"); await page.waitForSelector(".sent");
  await page.click("#r-read");
  await waitText("#status-text", /permission is off/);
  check("explains how to allow the microphone", true);
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
  await close();
  await server.close();
}

if (transcript.length) {
  console.log("\nSimulated conversation");
  transcript.forEach(([who, t]) => console.log("  " + who.padEnd(8) + t.replace(/\n/g, "\n" + " ".repeat(10))));
}
process.exit(finish());
