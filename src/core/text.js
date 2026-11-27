// Pure text and scoring helpers: no DOM, no storage, so they can be unit tested.

// A word as the grader compares it: lowercase letters, digits and inner apostrophes.
export function norm(w) {
  return String(w).toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9']/g, "").replace(/^'+|'+$/g, "");
}
// The words of a sentence, split on spaces, dashes and slashes ("to-do" is two words).
export function words(text) { return String(text).split(/[\s—–\-/]+/).map(norm).filter(Boolean); }
// A storage key for a word.
export function docId(w) { return norm(w).replace(/[^a-z0-9]/g, "_") || "_"; }

// Align what was heard against the target sentence (edit distance with backtrace).
// Returns one entry per target word: { ok: true } or { ok: false, heard } (heard "" = skipped).
export function align(target, heard) {
  const n = target.length, m = heard.length, dp = table(target, heard);
  const res = new Array(n);
  backtrace(target, heard, dp, n, m, res);
  return res;
}
// Same, for speech still in progress: the heard words are matched against the start of the
// sentence only, so words not read yet are "pending" instead of pulling the alignment apart.
export function alignPrefix(target, heard) {
  const n = target.length, m = heard.length, dp = table(target, heard);
  let end = 0;
  for (let i = 1; i <= n; i++) if (dp[i][m] <= dp[end][m]) end = i;
  const res = new Array(n);
  for (let i = end; i < n; i++) res[i] = { ok: false, heard: "", pending: true };
  backtrace(target, heard, dp, end, m, res);
  return res;
}
function table(target, heard) {
  const n = target.length, m = heard.length, dp = [];
  for (let i = 0; i <= n; i++) { dp.push(new Array(m + 1)); dp[i][0] = i; }
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const c = target[i - 1] === heard[j - 1] ? 0 : 1;
    dp[i][j] = Math.min(dp[i - 1][j - 1] + c, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
  }
  return dp;
}
function backtrace(target, heard, dp, i, j, res) {
  while (i > 0) {
    if (j > 0 && target[i - 1] === heard[j - 1] && dp[i][j] === dp[i - 1][j - 1]) { res[i - 1] = { ok: true }; i--; j--; }
    else if (j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) { res[i - 1] = { ok: false, heard: heard[j - 1] }; i--; j--; }
    else if (dp[i][j] === dp[i - 1][j] + 1) { res[i - 1] = { ok: false, heard: "" }; i--; }
    else { j--; }
  }
}

// The sentence and each of its words, as hints for Apple's recognizer (contextualStrings).
export function expectedPhrases(text) {
  const clean = (w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  const list = [String(text).replace(/[“”"]/g, "").trim()];
  String(text).split(/[\s—–/]+/).map(clean).forEach((w) => { if (w && list.indexOf(w) < 0) list.push(w); });
  return list.filter(Boolean);
}

// Share of words understood over a set of graded sentences { idx: { hit, total } }.
// Rounded down: 100% only when every word was understood.
export function accuracy(reads) {
  let h = 0, t = 0;
  Object.keys(reads || {}).forEach((k) => { h += reads[k].hit; t += reads[k].total; });
  return t ? Math.floor(100 * h / t) : null;
}
export function percent(hit, total) { return total ? Math.floor(100 * hit / total) : 0; }
// Color band of a score.
export function grade(pct) { return pct >= 90 ? "good" : pct >= 70 ? "mark" : "miss"; }

// Dates as local "YYYY-MM-DD" keys.
function pad(n) { return (n < 10 ? "0" : "") + n; }
export function dateKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
export function addDays(key, n) {
  const p = key.split("-"); const d = new Date(+p[0], +p[1] - 1, +p[2]);
  d.setDate(d.getDate() + n); return dateKey(d);
}
// Spaced review: a new word is first due the next day; each time it is known it comes back after
// 3, 7, 14, then every 30 days; a missed one comes back tomorrow.
export const INTERVALS = [1, 3, 7, 14, 30];
export function nextReview(step, knew, today) {
  const next = knew ? (step || 0) + 1 : 0;
  return { step: next, due: addDays(today, knew ? INTERVALS[Math.min(next, INTERVALS.length - 1)] : 1) };
}
// Consecutive practiced days ending today (or yesterday, if today is not practiced yet).
export function streak(practicedDates, today) {
  const days = {}; practicedDates.forEach((d) => { days[d] = 1; });
  let d = days[today] ? today : addDays(today, -1), n = 0;
  while (days[d]) { n++; d = addDays(d, -1); }
  return n;
}
