// Claude calls, with the Anthropic SDK replaced by a fake client (no network, no API key used).
import { describe, it, expect, vi, beforeEach } from "vitest";

const sdk = vi.hoisted(() => {
  class APIError extends Error { constructor(status) { super("api"); this.status = status; } }
  class AuthenticationError extends APIError {}
  class PermissionDeniedError extends APIError {}
  class NotFoundError extends APIError {}
  class RateLimitError extends APIError {}
  class APIConnectionError extends APIError {}
  const state = { reply: null, error: null, lastParams: null, constructed: [] };
  class Anthropic {
    constructor(opts) {
      state.constructed.push(opts);
      this.beta = { messages: { stream: (params) => {
        state.lastParams = params;
        const handlers = {};
        return {
          on(ev, fn) { handlers[ev] = fn; return this; },
          async finalMessage() {
            if (state.error) throw state.error;
            const r = state.reply;
            let snap = "";
            for (const part of r.parts || []) { snap += part; handlers.text && handlers.text(part, snap); }
            return { stop_reason: r.stop_reason || "end_turn", content: [{ type: "text", text: (r.parts || []).join("") }, { type: "thinking", thinking: "x" }] };
          },
        };
      } } };
    }
  }
  Object.assign(Anthropic, { APIError, AuthenticationError, PermissionDeniedError, NotFoundError, RateLimitError, APIConnectionError });
  return { Anthropic, state };
});
vi.mock("@anthropic-ai/sdk", () => ({ default: sdk.Anthropic }));

const { createAI, parseJSONReply, DEFAULT_MODEL, MODELS } = await import("../../src/platform/ai.js");

beforeEach(() => { sdk.state.reply = { parts: ["ok"] }; sdk.state.error = null; sdk.state.lastParams = null; sdk.state.constructed = []; });

describe("createAI", () => {
  it("needs an API key", () => {
    expect(createAI("", "x")).toBeNull();
    expect(createAI(undefined)).toBeNull();
  });
  it("uses Opus 5.5 by default and offers only current models", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
    expect(createAI("k").model).toBe("claude-opus-5-5");
    expect(MODELS.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  });
  it("calls the API from the app with the learner's key", async () => {
    await createAI("sk-test", "claude-haiku-5-5").ask("hi");
    expect(sdk.state.constructed[0]).toEqual({ apiKey: "sk-test", dangerouslyAllowBrowser: true });
  });
});

describe("ask", () => {
  it("streams the text as it arrives and returns the whole answer", async () => {
    sdk.state.reply = { parts: ["Good ", "job."] };
    const seen = [];
    const out = await createAI("k").ask("feedback please", { onText: (u) => seen.push(u.text) });
    expect(out).toBe("Good job.");
    expect(seen).toEqual(["Good ", "Good job."]);
  });
  it("sends the effort and the refusal fallback for Opus and Sonnet only", async () => {
    await createAI("k", "claude-opus-5-5").ask("x", { effort: "low" });
    expect(sdk.state.lastParams).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "low" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    expect(sdk.state.lastParams.messages).toEqual([{ role: "user", content: "x" }]);
    await createAI("k", "claude-haiku-5-5").ask("x");
    expect(sdk.state.lastParams.betas).toBeUndefined();
    expect(sdk.state.lastParams.fallbacks).toBeUndefined();
    expect(sdk.state.lastParams.output_config).toEqual({ effort: "low" });
  });
  it("reports a refusal", async () => {
    sdk.state.reply = { parts: [], stop_reason: "refusal" };
    await expect(createAI("k").ask("x")).rejects.toEqual({ code: "refusal" });
  });
  it.each([
    [() => new sdk.Anthropic.AuthenticationError(401), "bad_key"],
    [() => new sdk.Anthropic.PermissionDeniedError(403), "no_access"],
    [() => new sdk.Anthropic.NotFoundError(404), "model_not_found"],
    [() => new sdk.Anthropic.RateLimitError(429), "rate_limited"],
    [() => new sdk.Anthropic.APIConnectionError(), "offline"],
    [() => new sdk.Anthropic.APIError(529), "overloaded"],
    [() => new sdk.Anthropic.APIError(500), "server_error"],
    [() => new sdk.Anthropic.APIError(400), "api_error_400"],
    [() => new Error("boom"), "error"],
  ])("turns API errors into app error codes (%#)", async (make, code) => {
    sdk.state.error = make();
    await expect(createAI("k").ask("x")).rejects.toEqual({ code });
  });
});

describe("askJSON and parseJSONReply", () => {
  it("reads the JSON object even inside prose or a code fence", () => {
    expect(parseJSONReply('Here it is:\n```json\n{"a": {"b": [1, 2]}}\n```\nDone.')).toEqual({ a: { b: [1, 2] } });
  });
  it("rejects replies without valid JSON", () => {
    expect(() => parseJSONReply("no json here")).toThrow();
    try { parseJSONReply("{ broken: }"); } catch (e) { expect(e).toEqual({ code: "invalid_json" }); }
  });
  it("asks Claude and returns the parsed lesson", async () => {
    sdk.state.reply = { parts: ['{"title":"A story","sentences":["One."]}'] };
    const out = await createAI("k").askJSON("make a lesson");
    expect(out).toEqual({ title: "A story", sentences: ["One."] });
    expect(sdk.state.lastParams.output_config).toEqual({ effort: "medium" });
  });
});
