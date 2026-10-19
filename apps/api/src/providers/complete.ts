// Non-streaming completion on top of a ChatProvider's streaming interface.
// Accumulates onToken chunks into full text. Used by compaction (and any
// future server-side summarization), which needs the reply text, not a stream.

import type { ChatMessageInput, ChatProvider } from "./chatProvider.js";
import { recordProviderFailure, recordProviderSuccess } from "./circuit.js";

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CompleteOptions {
  system?: string;
  messages: ChatMessageInput[];
  signal?: AbortSignal;
}

export async function completeWithProvider(
  provider: ChatProvider,
  opts: CompleteOptions,
): Promise<CompletionResult> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  let text = "";
  try {
    const { inputTokens, outputTokens } = await provider.streamChat({
      system: opts.system,
      messages: opts.messages,
      signal: controller.signal,
      onToken: (chunk: string) => {
        text += chunk;
      },
    });
    // Choke point for the circuit breaker (chat provider calls from the
    // research runner, write generation, and compaction). The demo provider
    // never trips anything.
    if (provider.id !== "demo") recordProviderSuccess(provider.id);
    return { text, inputTokens, outputTokens };
  } catch (err) {
    if (provider.id !== "demo") recordProviderFailure(provider.id, err);
    throw err;
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}
