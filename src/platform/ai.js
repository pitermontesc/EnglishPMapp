// Claude, called with the learner's own Anthropic API key (kept on the device).
// Replaces the artifact's `sample` capability: ask(prompt, {onText}) streams text,
// askJSON(prompt) returns a parsed JSON object.
import Anthropic from "@anthropic-ai/sdk";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best quality)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, cheaper)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)" },
];
export const DEFAULT_MODEL = "claude-opus-5-5";
// Models that accept server-side refusal fallbacks.
const FALLBACK_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"];

export function createAI(apiKey, model) {
  if (!apiKey) return null;
  // The browser flag is required to call the API directly from a page or app web view.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const chosen = model || DEFAULT_MODEL;

  function params(prompt, effort) {
    const p = {
      model: chosen,
      max_tokens: 64000,
      output_config: { effort },
      messages: [{ role: "user", content: prompt }],
    };
    if (FALLBACK_MODELS.includes(chosen)) {
      p.betas = ["server-side-fallback-2026-07-01"];
      p.fallbacks = "default";
    }
    return p;
  }

  async function ask(prompt, opts = {}) {
    try {
      const stream = client.beta.messages.stream(params(prompt, opts.effort || "low"));
      if (opts.onText) stream.on("text", (_delta, snapshot) => opts.onText({ text: snapshot }));
      const msg = await stream.finalMessage();
      if (msg.stop_reason === "refusal") throw { code: "refusal" };
      return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    } catch (e) {
      throw toAppError(e);
    }
  }

  async function askJSON(prompt, opts = {}) {
    return parseJSONReply(await ask(prompt, { effort: opts.effort || "medium" }));
  }

  return { ask, askJSON, model: chosen };
}

// The JSON object in a reply, even when Claude wraps it in a sentence or a code fence.
export function parseJSONReply(text) {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw { code: "invalid_json" };
  try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { throw { code: "invalid_json" }; }
}

function toAppError(e) {
  if (e && e.code && !(e instanceof Error)) return e; // already ours
  if (e instanceof Anthropic.AuthenticationError) return { code: "bad_key" };
  if (e instanceof Anthropic.PermissionDeniedError) return { code: "no_access" };
  if (e instanceof Anthropic.NotFoundError) return { code: "model_not_found" };
  if (e instanceof Anthropic.RateLimitError) return { code: "rate_limited" };
  if (e instanceof Anthropic.APIConnectionError) return { code: "offline" };
  if (e instanceof Anthropic.APIError) return { code: "api_error_" + (e.status || "unknown") };
  return { code: "error" };
}
