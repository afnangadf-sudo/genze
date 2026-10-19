// Free keyless AI provider: real answers with zero keys and zero money.
//
// Used automatically when no provider key is configured (ANTHROPIC_API_KEY,
// OPENAI_API_KEY and GOOGLE_GENAI_API_KEY all unset). It calls a free
// community text API — only the chat messages and the system prompt ever
// leave the server; never identity (no name, email, user id, or IP beyond
// what the network itself reveals).
//
// Any transport/API failure throws FreeUnavailable so the caller falls back
// to the built-in demo provider (which never leaves the server).

import type { ChatProvider, StreamChatOptions, StreamChatResult } from "./chatProvider.js";
import { providerDisabledSet } from "./killswitches.js";
import { abortError } from "./sse.js";

export const FREE_PROVIDER_ID = "free" as const;

/** Distinct error: the free service could not answer. Caller falls back to demo. */
export class FreeUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreeUnavailable";
  }
}

const ENDPOINT = "https://text.pollinations.ai/";
const MAX_PROMPT_CHARS = 6000;
const REQUEST_TIMEOUT_MS = 55_000;

/** Kill-switchable (Step 5) and env-toggleable. Default ON. */
export function isFreeEnabled(): boolean {
  if (process.env.FREE_AI_ENABLED === "false") return false;
  if (providerDisabledSet().has(FREE_PROVIDER_ID)) return false;
  return true;
}

/** Fold system + conversation into the single prompt the free API takes. */
export function buildFreePrompt(
  system: string | undefined,
  messages: StreamChatOptions["messages"],
): string {
  const parts: string[] = [];
  const sys = (system ?? "").trim();
  if (sys) parts.push(sys);
  // Defensive newest-first char cap (the chat route already caps history).
  let budget = MAX_PROMPT_CHARS - parts.join("").length - 64;
  const lines: string[] = [];
  for (let i = messages.length - 1; i >= 0 && budget > 0; i--) {
    const m = messages[i];
    const content = (m.content ?? "").trim();
    if (!content) continue;
    const line = `${m.role === "assistant" ? "Assistant" : "User"}: ${content}`;
    if (line.length > budget) break;
    lines.unshift(line);
    budget -= line.length;
  }
  parts.push(...lines, "Assistant:");
  return parts.join("\n\n").slice(0, MAX_PROMPT_CHARS);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function makeFreeProvider(): ChatProvider {
  return {
    id: FREE_PROVIDER_ID,
    model: "free",
    async streamChat({ system, messages, signal, onToken }: StreamChatOptions): Promise<StreamChatResult> {
      if (signal.aborted) throw abortError();
      if (!isFreeEnabled()) throw new FreeUnavailable("free AI disabled");
      const prompt = buildFreePrompt(system, messages);
      if (!prompt.trim()) throw new FreeUnavailable("empty prompt");
      const url = `${ENDPOINT}${encodeURIComponent(prompt)}?model=openai&private=true`;

      let res: Response;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        const onAbort = () => ctrl.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          res = await fetch(url, {
            signal: ctrl.signal,
            headers: { Accept: "text/plain", "User-Agent": "Genze/1.0" },
          });
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        }
      } catch (e) {
        if (signal.aborted) throw abortError();
        throw new FreeUnavailable(`free AI unreachable: ${(e as Error).message ?? e}`);
      }
      if (!res.ok) throw new FreeUnavailable(`free AI HTTP ${res.status}`);
      const text = (await res.text()).trim();
      if (!text) throw new FreeUnavailable("free AI returned an empty reply");

      // The free API is not streaming: emit word-by-word so the UI still streams.
      const words = text.split(/\s+/);
      for (let i = 0; i < words.length; i++) {
        if (signal.aborted) throw abortError();
        onToken(words[i] + (i < words.length - 1 ? " " : ""));
        await abortableSleep(12, signal);
      }
      return {
        inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
        outputTokens: Math.ceil(text.length / 4),
      };
    },
  };
}
