// @vitest-environment jsdom
// The model voice on the web build, with the browser's speech synthesis replaced by a fake.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@capacitor-community/text-to-speech", () => ({ TextToSpeech: {} }));

const spoken = [];
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
window.speechSynthesis = {
  getVoices: () => [{ name: "Samantha", lang: "en-US" }, { name: "Google UK", lang: "en-GB" }],
  speak: (u) => spoken.push(u),
  cancel: vi.fn(() => { spoken.forEach((u) => u.onerror && u.onerror({ error: "interrupted" })); }),
};

const { chunks, speak, stop, ttsAvailable } = await import("../../src/platform/tts.js");

beforeEach(() => { spoken.length = 0; });
afterEach(() => vi.useRealTimers());

describe("chunks", () => {
  it("splits text into sentences, keeping closing quotes", () => {
    expect(chunks('He said "stop." Then why? Because!').map((s) => s.trim())).toEqual(['He said "stop."', "Then why?", "Because!"]);
  });
  it("keeps text without end punctuation as one piece", () => {
    expect(chunks("no punctuation here")).toEqual(["no punctuation here"]);
  });
});

describe("speak (web)", () => {
  it("is available when the browser has speech synthesis", () => { expect(ttsAvailable()).toBe(true); });

  it("speaks each sentence with an American voice and resolves when the last one ends", async () => {
    const p = speak("One. Two.", 0.75);
    expect(spoken.map((u) => u.text)).toEqual(["One.", "Two."]);
    expect(spoken.every((u) => u.lang === "en-US" && u.rate === 0.75 && u.voice.name === "Samantha")).toBe(true);
    spoken[1].onend();
    await expect(p).resolves.toBe("end");
  });

  it("resolves 'cancelled' when stopped", async () => {
    const p = speak("A long sentence.");
    stop();
    await expect(p).resolves.toBe("cancelled");
  });

  it("does not wait forever if the browser never says it finished", async () => {
    vi.useFakeTimers();
    const p = speak("Short.");
    vi.advanceTimersByTime(2500 + 6 * 110 + 10);
    await expect(p).resolves.toBe("end");
  });

  it("a new sentence interrupts the previous one", async () => {
    const first = speak("First.");
    const second = speak("Second.");
    await expect(first).resolves.toBe("cancelled");
    spoken[spoken.length - 1].onend();
    await expect(second).resolves.toBe("end");
  });
});
