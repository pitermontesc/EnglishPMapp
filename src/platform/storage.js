// Local storage for lessons, sessions, words and vocab.
// The Mac app uses Capacitor Preferences, which the OS does not purge.
// The web build uses localStorage. Each collection is kept as one JSON map in memory
// and written back whole on every change; the data set is small (hundreds of docs).
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

const NATIVE = Capacitor.isNativePlatform();
const PREFIX = "de:";
export const COLLECTIONS = ["lessons", "sessions", "words", "vocab"];

async function rawGet(key) {
  if (NATIVE) return (await Preferences.get({ key })).value;
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
async function rawSet(key, value) {
  if (NATIVE) { await Preferences.set({ key, value }); return; }
  try { localStorage.setItem(key, value); } catch (e) { throw { code: "storage_full" }; }
}
function parse(text, fallback) {
  if (!text) return fallback;
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : fallback; } catch (e) { return fallback; }
}
function clone(v) { return JSON.parse(JSON.stringify(v)); }

const cache = {};
let settings = {};
let chain = Promise.resolve();
function queue(fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; }

export async function openStore() {
  for (const c of COLLECTIONS) cache[c] = parse(await rawGet(PREFIX + c), {});
  settings = parse(await rawGet(PREFIX + "settings"), {});
  if (!NATIVE && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  return store;
}

export const store = {
  all(col) { return Object.values(cache[col] || {}).map(clone); },
  get(col, id) { const v = (cache[col] || {})[id]; return v ? clone(v) : null; },
  set(col, id, obj) {
    cache[col][id] = clone(obj);
    const snapshot = JSON.stringify(cache[col]);
    return queue(() => rawSet(PREFIX + col, snapshot));
  },
  exportAll() {
    return { app: "daily-english", version: 1, exportedAt: new Date().toISOString(), data: clone(cache) };
  },
  // Merges a backup into what is on this device. For the same id, the backup wins
  // unless the local copy was updated more recently (sessions carry updatedAt).
  async importAll(backup) {
    if (!backup || backup.app !== "daily-english" || !backup.data) throw { code: "not_a_backup" };
    let n = 0;
    for (const c of COLLECTIONS) {
      const incoming = backup.data[c] || {};
      for (const id of Object.keys(incoming)) {
        const mine = cache[c][id], theirs = incoming[id];
        if (mine && mine.updatedAt && theirs.updatedAt && mine.updatedAt > theirs.updatedAt) continue;
        cache[c][id] = theirs; n++;
      }
      const snapshot = JSON.stringify(cache[c]);
      await queue(() => rawSet(PREFIX + c, snapshot));
    }
    return n;
  },
};

export function getSetting(key, fallback) { return key in settings ? settings[key] : fallback; }
export function setSettings(patch) {
  settings = Object.assign({}, settings, patch);
  const snapshot = JSON.stringify(settings);
  return queue(() => rawSet(PREFIX + "settings", snapshot));
}
