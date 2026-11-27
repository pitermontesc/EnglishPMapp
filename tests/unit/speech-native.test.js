// The Mac app's dictation adapter, with Apple's speech plugin replaced by a fake that lets the
// test fire the plugin's events (partial results, state changes, levels, errors) by hand.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const plugin = vi.hoisted(() => ({
  listeners: {},
  available: vi.fn(async () => ({ available: true })),
  checkPermissions: vi.fn(async () => ({ speechRecognition: "granted" })),
  requestPermissions: vi.fn(async () => ({ speechRecognition: "granted" })),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  addListener: vi.fn(async (name, fn) => { plugin.listeners[name] = fn; return { remove() {} }; }),
  emit(name, data) { plugin.listeners[name] && plugin.listeners[name](data); },
}));
vi.mock("@capgo/capacitor-speech-recognition", () => ({ SpeechRecognition: plugin }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios" },
  CapacitorHttp: { post: vi.fn(async () => ({})) },
}));

const { createDictation, micLog } = await import("../../src/platform/speech.js");

async function dictation() {
  const d = await createDictation();
  const got = { finals: [], partials: [], states: [], levels: [] };
  d.onFinal((e) => got.finals.push(e.text));
  d.onPartial((e) => got.partials.push(e.text));
  d.onState((e) => got.states.push(e));
  d.onLevel((e) => got.levels.push(e.level));
  return { d, got };
}

beforeEach(() => {
  plugin.listeners = {};
  vi.clearAllMocks();
  plugin.checkPermissions.mockImplementation(async () => ({ speechRecognition: "granted" }));
  plugin.start.mockImplementation(async () => {});
});
afterEach(() => vi.useRealTimers());

describe("native dictation", () => {
  it("is unavailable when the recognizer is not available", async () => {
    plugin.available.mockResolvedValueOnce({ available: false });
    expect(await createDictation()).toBeNull();
  });

  it("starts Apple's recognizer in English with live results and the expected words", async () => {
    const { d } = await dictation();
    await d.start({ phrases: ["Nobody could explain why.", "why"] });
    expect(plugin.start).toHaveBeenCalledWith(expect.objectContaining({
      language: "en-US", partialResults: true, popup: false, contextualStrings: ["Nobody could explain why.", "why"],
    }));
  });

  it("asks for permission when needed and reports a refusal", async () => {
    plugin.checkPermissions.mockResolvedValueOnce({ speechRecognition: "prompt" });
    plugin.requestPermissions.mockResolvedValueOnce({ speechRecognition: "denied" });
    const { d } = await dictation();
    await expect(d.start()).rejects.toEqual({ code: "not_granted" });
    expect(plugin.start).not.toHaveBeenCalled();
  });

  it("reports the plugin's start error code", async () => {
    plugin.start.mockRejectedValueOnce({ code: "RECOGNIZER_UNAVAILABLE" });
    const { d } = await dictation();
    await expect(d.start()).rejects.toEqual({ code: "RECOGNIZER_UNAVAILABLE" });
  });

  it("forwards partial results, preferring the plugin's accumulated text", async () => {
    const { d, got } = await dictation();
    await d.start();
    plugin.emit("partialResults", { matches: ["every friday"] });
    plugin.emit("partialResults", { matches: ["afternoon"], accumulated: "every friday" });
    plugin.emit("partialResults", { matches: ["x"], accumulatedText: "every friday afternoon our" });
    expect(got.partials).toEqual(["every friday", "every friday afternoon", "every friday afternoon our"]);
  });

  it("ignores results and levels that arrive when no take is active", async () => {
    const { got } = await dictation();
    plugin.emit("partialResults", { matches: ["stray"] });
    plugin.emit("audioLevel", { level: 0.5 });
    expect(got.partials).toEqual([]);
    expect(got.levels).toEqual([]);
  });

  it("forwards microphone levels during a take", async () => {
    const { d, got } = await dictation();
    await d.start();
    plugin.emit("audioLevel", { level: 0.42 });
    plugin.emit("audioLevel", { level: "bad" });
    expect(got.levels).toEqual([0.42, 0]);
  });

  it("delivers the final text and goes idle when Apple stops", async () => {
    const { d, got } = await dictation();
    await d.start();
    plugin.emit("partialResults", { matches: ["nobody could explain why"] });
    plugin.emit("listeningState", { state: "stopped", status: "stopped" });
    expect(got.finals).toEqual(["nobody could explain why"]);
    expect(got.states).toEqual([{ state: "idle", reason: "" }]);
    // A second "stopped" event does not finish twice.
    plugin.emit("listeningState", { state: "stopped" });
    expect(got.states.length).toBe(1);
  });

  it("goes idle without a final text when nothing was heard", async () => {
    const { d, got } = await dictation();
    await d.start();
    plugin.emit("listeningState", { status: "stopped" });
    expect(got.finals).toEqual([]);
    expect(got.states.length).toBe(1);
  });

  it("waits for Apple's final result after stop, and finishes on its own if it never comes", async () => {
    vi.useFakeTimers();
    const { d, got } = await dictation();
    await d.start();
    plugin.emit("partialResults", { matches: ["nobody could explain"] });
    await d.stop();
    expect(plugin.stop).toHaveBeenCalled();
    // The last word arrives in the final result 1.5 s after stop: it must be kept.
    vi.advanceTimersByTime(1500);
    plugin.emit("partialResults", { matches: ["nobody could explain why"] });
    expect(got.finals).toEqual([]);
    vi.advanceTimersByTime(1600); // past the 3 s guard
    expect(got.finals).toEqual(["nobody could explain why"]);
    expect(got.states.length).toBe(1);
  });

  it("marks a permission error so the app can explain it", async () => {
    const { d, got } = await dictation();
    await d.start();
    plugin.emit("error", { code: "MICROPHONE_PERMISSION_DENIED" });
    plugin.emit("listeningState", { state: "stopped" });
    expect(got.states).toEqual([{ state: "idle", reason: "not_granted" }]);
  });

  it("keeps a copyable microphone log of what happened", async () => {
    const { d } = await dictation();
    await d.start();
    plugin.emit("listeningState", { state: "stopped" });
    expect(micLog()).toMatch(/native start: calling plugin start/);
    expect(micLog()).toMatch(/native finish/);
  });
});
