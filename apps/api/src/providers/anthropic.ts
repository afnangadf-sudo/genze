// Anthropic Messages API streaming chat provider (global fetch, SSE).
// Key comes from ANTHROPIC_API_KEY only — never logged, never returned.

import type {
  ChatProvider,
  ProviderToolCall,
  StreamChatOptions,
  StreamChatResult,
  ToolDecisionOptions,
  ToolDecisionResult,
} from "./chatProvider.js";
import { abortError, readSseEvents } from "./sse.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

function providerError(status: number, message: string): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = status;
  return err;
}

function requireKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw providerError(503, "Anthropic is not configured.");
  return key;
}

/**
 * One non-streaming tool-decision call (Step 6): native Anthropic tools API.
 * Returns the model's requested tool calls (possibly empty).
 */
export async function anthropicDecideToolCalls(
  model: string,
  options: ToolDecisionOptions,
): Promise<ToolDecisionResult> {
  const key = requireKey();
  if (options.signal.aborted) throw abortError();

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? 512,
        ...(options.system ? { system: options.system } : {}),
        // Decision call is text-only: vision images don't travel here.
        messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
        tools: options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        tool_choice: { type: "auto" },
      }),
      signal: options.signal,
    });
  } catch (err) {
    if (options.signal.aborted || (err as Error)?.name === "AbortError") throw abortError();
    throw err;
  }

  if (!res.ok) {
    let message = `Anthropic request failed (HTTP ${res.status}).`;
    try {
      const payload = (await res.json()) as { error?: { message?: string } };
      if (payload?.error?.message) message = payload.error.message;
    } catch {
      // keep the generic message
    }
    throw providerError(res.status, message);
  }

  const payload = (await res.json()) as {
    content?: Array<{ type?: string; name?: string; input?: unknown }>;
  };
  const toolCalls: ProviderToolCall[] = [];
  for (const block of payload.content ?? []) {
    if (block?.type === "tool_use" && typeof block.name === "string") {
      const input =
        block.input && typeof block.input === "object"
          ? (block.input as Record<string, unknown>)
          : {};
      toolCalls.push({ name: block.name, input });
    }
  }
  return { toolCalls };
}

export function makeAnthropicProvider(model: string): ChatProvider {
  return {
    id: "anthropic",
    model,
    decideToolCalls: (options: ToolDecisionOptions) => anthropicDecideToolCalls(model, options),
    async streamChat({ system, messages, signal, onToken }: StreamChatOptions): Promise<StreamChatResult> {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) {
        const err = new Error("Anthropic is not configured.") as Error & { statusCode: number };
        err.statusCode = 503;
        throw err;
      }
      if (signal.aborted) throw abortError();

      let res: Response;
      try {
        res = await fetch(ANTHROPIC_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            stream: true,
            ...(system ? { system } : {}),
            messages: messages.map((m) => ({
              role: m.role,
              content:
                m.images && m.images.length > 0
                  ? [
                      { type: "text", text: m.content },
                      ...m.images.map((img) => ({
                        type: "image",
                        source: { type: "base64", media_type: img.mimeType, data: img.base64 },
                      })),
                    ]
                  : m.content,
            })),
          }),
          signal,
        });
      } catch (err) {
        if (signal.aborted || (err as Error)?.name === "AbortError") throw abortError();
        throw err;
      }

      if (!res.ok) {
        let message = `Anthropic request failed (HTTP ${res.status}).`;
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
        let evt: {
          type?: string;
          message?: { usage?: { input_tokens?: number } };
          delta?: { type?: string; text?: string };
          usage?: { output_tokens?: number };
        };
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        if (evt.type === "message_start" && evt.message?.usage?.input_tokens != null) {
          inputTokens = evt.message.usage.input_tokens;
        } else if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && typeof evt.delta.text === "string") {
          onToken(evt.delta.text);
        } else if (evt.type === "message_delta" && evt.usage?.output_tokens != null) {
          outputTokens = evt.usage.output_tokens;
        }
      }
      return { inputTokens, outputTokens };
    },
  };
}
