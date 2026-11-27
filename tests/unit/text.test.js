import { describe, it, expect } from "vitest";
import {
  norm, words, docId, align, alignPrefix, expectedPhrases,
  accuracy, percent, grade, dateKey, addDays, nextReview, streak,
} from "../../src/core/text.js";

const W = (s) => words(s);
const oks = (res) => res.map((r) => (r && r.ok ? 1 : 0)).join("");

describe("norm and words", () => {
  it("lowercases and strips punctuation but keeps inner apostrophes", () => {
    expect(norm("Why.")).toBe("why");
    expect(norm("“It’s")).toBe("it's");
    expect(norm("'quoted'")).toBe("quoted");
    expect(norm("—")).toBe("");
  });
  it("splits on spaces, dashes and slashes and drops empty tokens", () => {
    expect(W("A crawl—and nobody / on-call")).toEqual(["a", "crawl", "and", "nobody", "on", "call"]);
    expect(W("  ")).toEqual([]);
  });
  it("makes storage-safe ids", () => {
    expect(docId("It's")).toBe("it_s");
    expect(docId("!!")).toBe("_");
  });
});

describe("align (final grading)", () => {
  const target = W("nobody could explain why");
  it("marks every word ok on a perfect reading", () => {
    expect(oks(align(target, W("Nobody could explain why.")))).toBe("1111");
  });
  it("reports a substituted word with what was heard", () => {
    const res = align(target, W("nobody could explain Y"));
    expect(res[3]).toEqual({ ok: false, heard: "y" });
  });
  it("reports a skipped word with empty heard", () => {
    const res = align(target, W("nobody explain why"));
    expect(oks(res)).toBe("1011");
    expect(res[1]).toEqual({ ok: false, heard: "" });
  });
  it("ignores extra words that were not in the sentence", () => {
    expect(oks(align(target, W("um nobody could really explain why")))).toBe("1111");
  });
  it("marks the last word missed when the final text lost it", () => {
    expect(oks(align(target, W("nobody could explain")))).toBe("1110");
  });
  it("handles empty inputs", () => {
    expect(align([], W("hello"))).toEqual([]);
    expect(oks(align(target, []))).toBe("0000");
  });
});

describe("alignPrefix (speech in progress)", () => {
  const target = W("every friday afternoon our checkout page slowed");
  it("leaves the words not read yet as pending, not wrong", () => {
    const res = alignPrefix(target, W("every friday afternoon"));
    expect(oks(res)).toBe("1110000");
    expect(res.slice(3).every((r) => r.pending)).toBe(true);
  });
  it("does not let a misheard word pull the rest apart", () => {
    const res = alignPrefix(target, W("every friday afternoon hour checkout"));
    expect(res[3]).toEqual({ ok: false, heard: "hour" });
    expect(res[4]).toEqual({ ok: true });
    expect(res[5].pending).toBe(true);
  });
  it("matches a single trailing word only in context, not alone", () => {
    // Text that holds just the sentence's last word cannot be placed at the end of the sentence.
    expect(alignPrefix(target, W("slowed"))[6].ok).toBe(false);
  });
});

describe("expectedPhrases", () => {
  it("gives the whole sentence first, then each distinct word without punctuation", () => {
    const list = expectedPhrases("“It’s the intern’s fault,” she said—again, the intern.");
    expect(list[0]).toBe("It’s the intern’s fault, she said—again, the intern.");
    expect(list).toContain("It’s");
    expect(list).toContain("fault");
    expect(list).toContain("again");
    expect(list.filter((w) => w === "the").length).toBe(1);
    expect(list).not.toContain("");
  });
  it("returns nothing for an empty sentence", () => {
    expect(expectedPhrases("")).toEqual([]);
  });
});

describe("scores", () => {
  it("rounds down so 100% means every word", () => {
    expect(accuracy({ 0: { hit: 199, total: 200 } })).toBe(99);
    expect(accuracy({ 0: { hit: 10, total: 10 }, 1: { hit: 5, total: 10 } })).toBe(75);
    expect(accuracy({})).toBeNull();
    expect(percent(15, 16)).toBe(93);
    expect(percent(0, 0)).toBe(0);
  });
  it("bands scores by color", () => {
    expect([grade(100), grade(90), grade(89), grade(70), grade(69)]).toEqual(["good", "good", "mark", "mark", "miss"]);
  });
});

describe("dates, review and streak", () => {
  it("adds days across months, years and leap days", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(dateKey(new Date(2026, 10, 5))).toBe("2026-11-05");
  });
  it("adds days correctly across a daylight-saving change", () => {
    expect(addDays("2026-03-07", 2)).toBe("2026-03-09");
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02");
  });
  it("spaces reviews 3, 7, 14, then 30 days, and resets a missed word to tomorrow", () => {
    const t = "2026-11-27";
    expect(nextReview(0, true, t)).toEqual({ step: 1, due: "2026-11-30" });
    expect(nextReview(1, true, t)).toEqual({ step: 2, due: "2026-12-04" });
    expect(nextReview(2, true, t)).toEqual({ step: 3, due: "2026-12-11" });
    expect(nextReview(3, true, t).due).toBe("2026-12-27");
    expect(nextReview(9, true, t).due).toBe("2026-12-27");
    expect(nextReview(4, false, t)).toEqual({ step: 0, due: "2026-11-28" });
    expect(nextReview(undefined, true, t).step).toBe(1);
  });
  it("counts consecutive days ending today or yesterday", () => {
    expect(streak(["2026-11-25", "2026-11-26", "2026-11-27"], "2026-11-27")).toBe(3);
    expect(streak(["2026-11-25", "2026-11-26"], "2026-11-27")).toBe(2);
    expect(streak(["2026-11-24", "2026-11-26"], "2026-11-27")).toBe(1);
    expect(streak(["2026-11-20"], "2026-11-27")).toBe(0);
    expect(streak([], "2026-11-27")).toBe(0);
  });
});
