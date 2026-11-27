// @vitest-environment jsdom
// Local data (web build: localStorage): saving, copies, backups and settings.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@capacitor/preferences", () => ({ Preferences: {} }));

async function freshStore(seed = {}) {
  vi.resetModules();
  localStorage.clear();
  Object.entries(seed).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
  const mod = await import("../../src/platform/storage.js");
  await mod.openStore();
  return mod;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => localStorage.clear());

describe("store", () => {
  it("saves records and reads them back after reopening", async () => {
    let m = await freshStore();
    await m.store.set("words", "why", { word: "why", misses: 2 });
    m = await (async () => { vi.resetModules(); const x = await import("../../src/platform/storage.js"); await x.openStore(); return x; })();
    expect(m.store.get("words", "why")).toEqual({ word: "why", misses: 2 });
    expect(m.store.all("words").length).toBe(1);
  });

  it("returns copies, so changing a result does not change the stored record", async () => {
    const { store } = await freshStore();
    await store.set("words", "a", { word: "a", misses: 1 });
    const copy = store.get("words", "a"); copy.misses = 99;
    expect(store.get("words", "a").misses).toBe(1);
    expect(store.get("words", "missing")).toBeNull();
  });

  it("survives corrupted saved data", async () => {
    localStorage.setItem("de:words", "{not json");
    vi.resetModules();
    const { openStore, store } = await import("../../src/platform/storage.js");
    await openStore();
    expect(store.all("words")).toEqual([]);
  });

  it("keeps settings and falls back to defaults", async () => {
    const { getSetting, setSettings } = await freshStore();
    expect(getSetting("pause", "long")).toBe("long");
    await setSettings({ pause: "short" });
    expect(getSetting("pause", "long")).toBe("short");
    expect(JSON.parse(localStorage.getItem("de:settings"))).toEqual({ pause: "short" });
  });

  it("writes in order even when several saves happen at once", async () => {
    const { store } = await freshStore();
    store.set("words", "a", { n: 1 }); store.set("words", "b", { n: 2 }); await store.set("words", "a", { n: 3 });
    await flush();
    expect(JSON.parse(localStorage.getItem("de:words"))).toEqual({ a: { n: 3 }, b: { n: 2 } });
  });
});

describe("backups", () => {
  it("exports everything and imports it on another device", async () => {
    const a = await freshStore();
    await a.store.set("vocab", "tenable", { word: "tenable" });
    await a.store.set("sessions", "2026-11-27", { date: "2026-11-27", updatedAt: "2026-11-27T10:00:00Z" });
    const backup = JSON.parse(JSON.stringify(a.store.exportAll()));
    expect(backup.app).toBe("daily-english");

    const b = await freshStore();
    expect(await b.store.importAll(backup)).toBe(2);
    expect(b.store.get("vocab", "tenable")).toEqual({ word: "tenable" });
  });

  it("keeps the local copy when it is newer than the backup's", async () => {
    const m = await freshStore();
    await m.store.set("sessions", "d", { v: "local", updatedAt: "2026-11-27T12:00:00Z" });
    const n = await m.store.importAll({ app: "daily-english", data: { sessions: { d: { v: "backup", updatedAt: "2026-11-27T09:00:00Z" } } } });
    expect(n).toBe(0);
    expect(m.store.get("sessions", "d").v).toBe("local");
  });

  it("takes the backup's copy when it is newer", async () => {
    const m = await freshStore();
    await m.store.set("sessions", "d", { v: "local", updatedAt: "2026-11-27T09:00:00Z" });
    await m.store.importAll({ app: "daily-english", data: { sessions: { d: { v: "backup", updatedAt: "2026-11-27T12:00:00Z" } } } });
    expect(m.store.get("sessions", "d").v).toBe("backup");
  });

  it("rejects files that are not Daily English backups", async () => {
    const { store } = await freshStore();
    await expect(store.importAll({ hello: 1 })).rejects.toEqual({ code: "not_a_backup" });
    await expect(store.importAll(null)).rejects.toEqual({ code: "not_a_backup" });
  });
});
