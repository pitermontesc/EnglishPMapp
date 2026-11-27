// @vitest-environment jsdom
// Chrome's dictation adapter, with the Web Speech API replaced by a fake recognizer.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@capgo/capacitor-speech-recognition", () => ({ SpeechRecognition: {} }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  CapacitorHttp: { post: vi.fn(async () => ({})) },
}));

let last = null;
class FakeRecognition {
  constructor() { last = this; this.started = false; }
  start() { this.started = true; }
  stop() { this.onend && this.onend(); }
  result(index, items) { // items: [text, isFinal]
    const results = items.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f }));
    this.onresult({ resultIndex: index, results });
  }
}

const { createDictation } = await import("../../src/platform/speech.js");

beforeEach(() => { last = null; delete window.webkitSpeechRecognition; delete window.SpeechRecognition; });

async function dictation() {
  window.webkitSpeechRecognition = FakeRecognition;
  const d = await createDictation();
  const got = { finals: [], partials: [], states: [] };
  d.onFinal((e) => got.finals.push(e.text));
  d.onPartial((e) => got.partials.push(e.text));
  d.onState((e) => got.states.push(e));
  return { d, got };
}

describe("web dictation", () => {
  it("is unavailable in browsers without speech recognition", async () => {
    expect(await createDictation()).toBeNull();
  });

  it("listens continuously in English with interim results", async () => {
    const { d } = await dictation();
    await d.start();
    expect(last).toMatchObject({ lang: "en-US", continuous: true, interimResults: true, started: true });
  });

  it("separates final and interim text", async () => {
    const { d, got } = await dictation();
    await d.start();
    last.result(0, [["every friday", false]]);
    last.result(0, [["every friday afternoon", true], ["our check", false]]);
    expect(got.partials).toEqual(["every friday", "our check"]);
    expect(got.finals).toEqual(["every friday afternoon "]);
  });

  it.each([
    ["not-allowed", "not_granted"],
    ["service-not-allowed", "not_granted"],
    ["audio-capture", "no_microphone"],
    ["network", "network"],
    ["no-speech", ""],
  ])("maps the %s error to reason '%s' when it ends", async (error, reason) => {
    const { d, got } = await dictation();
    await d.start();
    last.onerror({ error });
    await d.stop();
    expect(got.states).toEqual([{ state: "idle", reason }]);
  });

  it("stop before start does nothing", async () => {
    const { d, got } = await dictation();
    await d.stop();
    expect(got.states).toEqual([]);
  });
});
