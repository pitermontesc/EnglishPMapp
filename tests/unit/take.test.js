import { describe, it, expect } from "vitest";
import { words } from "../../src/core/text.js";
import { PAUSES, pauseFactor, takeProgress, silenceWait, createVoiceMeter, bestShown } from "../../src/core/take.js";

const target = words("Every Friday afternoon our checkout page slowed to a crawl and nobody on the team could explain why.");

describe("takeProgress", () => {
  it("is not finished while the sentence is still being read", () => {
    const p = takeProgress(target, words("every friday afternoon our checkout"));
    expect(p.finished).toBe(false);
    expect(p.okIdx).toEqual([0, 1, 2, 3, 4]);
    expect(p.coverage).toBeCloseTo(5 / 18);
  });
  it("is finished when the last word is heard last and most of the sentence was read", () => {
    const p = takeProgress(target, words("every friday afternoon our checkout page slowed to a crawl and nobody on the team could explain why"));
    expect(p.finished).toBe(true);
    expect(p.okIdx.length).toBe(18);
  });
  it("is not finished when only the end of the sentence was heard", () => {
    expect(takeProgress(target, words("could explain why")).finished).toBe(false);
  });
  it("is not finished when the last word was misheard", () => {
    const p = takeProgress(target, words("every friday afternoon our checkout page slowed to a crawl and nobody on the team could explain Y"));
    expect(p.finished).toBe(false);
    expect(p.okIdx).not.toContain(17);
  });
  it("is not fooled by the sentence's last word appearing earlier", () => {
    const t = words("the team found the bug that broke the team");
    expect(takeProgress(t, words("the team")).finished).toBe(false);
  });
  it("handles an empty target", () => {
    expect(takeProgress([], words("hello"))).toEqual({ okIdx: [], finished: false, coverage: 0 });
  });
});

describe("silenceWait", () => {
  it("waits less once the sentence is finished, more early on, scaled by the pause setting", () => {
    expect(silenceWait(true, 1, 1)).toBe(1000);
    expect(silenceWait(false, 0.6, 1)).toBe(2400);
    expect(silenceWait(false, 0.2, 1)).toBe(3400);
    expect(silenceWait(false, 0.6, PAUSES.long)).toBeCloseTo(3840);
  });
  it("maps the pause setting with a safe default", () => {
    expect(pauseFactor("short")).toBe(0.6);
    expect(pauseFactor("long")).toBe(1.6);
    expect(pauseFactor("nonsense")).toBe(1);
    expect(pauseFactor(undefined)).toBe(1);
  });
});

describe("voice meter", () => {
  it("learns the room's noise and detects a voice above it", () => {
    const m = createVoiceMeter();
    let t = 0;
    for (let i = 0; i < 15; i++) expect(m.update(0.3, (t += 66)).voice).toBe(false); // room noise
    expect(m.update(0.62, (t += 66)).voice).toBe(true); // speech
    expect(m.update(0.32, (t += 66)).voice).toBe(false);
  });
  it("does not take steady louder noise for a voice for long", () => {
    const m = createVoiceMeter();
    m.update(0.2, 0);
    // A noise that stays at 0.4 for 30 s: the floor rises toward it.
    let voice = true, t = 0;
    for (let i = 0; i < 450; i++) voice = m.update(0.4, (t += 66)).voice;
    expect(voice).toBe(false);
  });
  it("drops the floor at once when it gets quieter", () => {
    const m = createVoiceMeter();
    m.update(0.5, 0); m.update(0.1, 66);
    expect(m.floor).toBe(0.1);
    expect(m.update(0.3, 132).voice).toBe(true);
  });
  it("reports a change only when the voice state flips", () => {
    const m = createVoiceMeter();
    expect(m.update(0.1, 0).changed).toBe(false);
    expect(m.update(0.5, 66).changed).toBe(true);
    expect(m.update(0.5, 132).changed).toBe(false);
    expect(m.update(0.1, 198).changed).toBe(true);
  });
  it("keeps the ring between 0 and 1", () => {
    const m = createVoiceMeter();
    expect(m.update(0.1, 0).ring).toBe(0);
    expect(m.update(1, 66).ring).toBe(1);
  });
  it("is quiet only after the voice has been silent for the hold time", () => {
    const m = createVoiceMeter();
    m.update(0.1, 0); m.update(0.6, 1000); // voice at t=1000
    expect(m.quietFor(1500, 1600)).toEqual({ quiet: false, waitMore: 1200 });
    expect(m.quietFor(2600, 1600).quiet).toBe(true);
  });
  it("without level readings (web) a pause in the text counts as quiet", () => {
    expect(createVoiceMeter().quietFor(5000, 1600)).toEqual({ quiet: true, waitMore: 0 });
  });
});

describe("bestShown", () => {
  const t = words("nobody could explain why");
  it("keeps Apple's final text when it is as complete as anything heard", () => {
    expect(bestShown(t, "nobody could explain why", words("nobody could explain why"), "nobody could explain", 3)).toBe("nobody could explain why");
  });
  it("shows the earlier, more complete hypothesis when the final text dropped a word", () => {
    expect(bestShown(t, "nobody could explain", words("nobody could explain"), "nobody could explain why", 4)).toBe("nobody could explain why");
  });
  it("uses the final text when there is no target or no earlier text", () => {
    expect(bestShown(null, "hello", words("hello"), "x", 9)).toBe("hello");
    expect(bestShown(t, "nobody", words("nobody"), "", -1)).toBe("nobody");
  });
});

// The bug the learner reported: Apple's text stalls while they are still speaking.
// Simulated timeline of one take with the decisions the app makes.
describe("take timeline: text arrives late while the learner keeps speaking", () => {
  it("does not close the take until the voice is really quiet", () => {
    const factor = PAUSES.long, hold = 1000 * factor, m = createVoiceMeter();
    const levels = []; // 15 Hz: noise until 500 ms, voice until 9000 ms, then silence
    for (let t = 0; t <= 14000; t += 66) levels.push([t, t > 500 && t < 9000 ? 0.65 : 0.25]);
    // Apple's text: words until 3000 ms, then nothing (a server stall) although the voice goes on.
    const lastText = 3000, wait = silenceWait(false, 0.6, factor);
    let closedAt = null, checkAt = lastText + wait;
    for (const [t, lvl] of levels) {
      m.update(lvl, t);
      if (closedAt == null && t >= checkAt) {
        const q = m.quietFor(t, hold);
        if (q.quiet) closedAt = t; else checkAt = t + q.waitMore;
      }
    }
    expect(closedAt).toBeGreaterThanOrEqual(9000 + hold);
    expect(closedAt).toBeLessThan(9000 + hold + 400);
  });
});
