// OpenAI chat completions streaming provider (global fetch, SSE).
// Key comes from OPENAI_API_KEY only — never logged, never returned.

import type {
  ChatProvider,
  ProviderToolCall,
  StreamChatOptions,
  StreamChatResult,
  ToolDecisionOptions,
  ToolDecisionResult,
} from "./chatProvider.js";
import { abortError, readSseEvents } from "./sse.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

function providerError(status: number, message: string): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = status;
  return err;
}

/**
 * One non-streaming tool-decision call (Step 6): native OpenAI function-
 * calling API. Returns the model's requested tool calls (possibly empty).
 */
export async function openaiDecideToolCalls(
  model: string,
  options: ToolDecisionOptions,
): Promise<ToolDecisionResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw providerError(503, "OpenAI is not configured.");
  if (options.signal.aborted) throw abortError();

  const wireMessages: Array<{ role: string; content: string }> = [];
  if (options.system) wireMessages.push({ role: "system", content: options.system });
  // Decision call is text-only: vision images don't travel here.
  for (const m of options.messages) wireMessages.push({ role: m.role, content: m.content });

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: wireMessages,
        tools: options.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        })),
        tool_choice: "auto",
      }),
      signal: options.signal,
    });
  } catch (err) {
    if (options.signal.aborted || (err as Error)?.name === "AbortError") throw abortError();
    throw err;
  }

  if (!res.ok) {
    let message = `OpenAI request failed (HTTP ${res.status}).`;
    try {
      const payload = (await res.json()) as { error?: { message?: string } };
      if (payload?.error?.message) message = payload.error.message;
    } catch {
      // keep the generic message
    }
    throw providerError(res.status, message);
  }

  const payload = (await res.json()) as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  const toolCalls: ProviderToolCall[] = [];
  for (const tc of payload.choices?.[0]?.message?.tool_calls ?? []) {
    const name = tc?.function?.name;
    if (tc?.type !== "function" || typeof name !== "string") continue;
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(tc.function?.arguments ?? "{}");
      if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
    } catch {
      // keep empty input
    }
    toolCalls.push({ name, input });
  }
  return { toolCalls };
}

export function makeOpenAIProvider(model: string): ChatProvider {
  return {
    id: "openai",
    model,
    decideToolCalls: (options: ToolDecisionOptions) => openaiDecideToolCalls(model, options),
    async streamChat({ system, messages, signal, onToken }: StreamChatOptions): Promise<StreamChatResult> {
      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        const err = new Error("OpenAI is not configured.") as Error & { statusCode: number };
        err.statusCode = 503;
        throw err;
      }
      if (signal.aborted) throw abortError();

      const wireMessages: Array<{ role: string; content: unknown }> = [];
      if (system) wireMessages.push({ role: "system", content: system });
      for (const m of messages) {
        wireMessages.push({
          role: m.role,
          content:
            m.images && m.images.length > 0
              ? [
                  { type: "text", text: m.content },
                  ...m.images.map((img) => ({
                    type: "image_url",
                    image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
                  })),
                ]
              : m.content,
        });
      }

      let res: Response;
      try {
        res = await fetch(OPENAI_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            stream: true,
            stream_options: { include_usage: true },
            messages: wireMessages,
          }),
          signal,
        });
      } catch (err) {
        if (signal.aborted || (err as Error)?.name === "AbortError") throw abortError();
        throw err;
      }

      if (!res.ok) {
        let message = `OpenAI request failed (HTTP ${res.status}).`;
        try {
          const payload = (await res.json()) as { error?: { message?: string } };
          if (payload?.error?.message) message = payload.error.message;
        } catch {
          // keep the generic message
        }
        const err = new Error(message) as Error & { statusCode: number };
        err.statusCode = res.status;
        throw err;
      }

      let inputTokens = 0;
      let outputTokens = 0;
      for await (const { data } of readSseEvents(res.body, signal)) {
        if (data === "[DONE]") break;
        let chunk: {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const text = chunk.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text.length > 0) onToken(text);
        if (chunk.usage?.prompt_tokens != null) inputTokens = chunk.usage.prompt_tokens;
        if (chunk.usage?.completion_tokens != null) outputTokens = chunk.usage.completion_tokens;
      }
      return { inputTokens, outputTokens };
    },
  };
}
