// ChatProvider: the streaming interface every chat-capable provider
// (anthropic, openai, demo) implements. Provider keys are read from the
// environment lazily inside streamChat — never logged, never returned.

import type { ProviderId } from "@genze/shared";

export interface ChatImageInput {
  mimeType: string;
  base64: string;
}

export interface ChatMessageInput {
  role: "user" | "assistant";
  content: string;
  /** Vision images for this message (latest user message only in practice). */
  images?: ChatImageInput[];
}

export interface StreamChatOptions {
  /** Optional system instruction (sent as `system` to Anthropic, as a system
   *  message to OpenAI; ignored by the demo provider). */
  system?: string;
  messages: ChatMessageInput[];
  signal: AbortSignal;
  onToken: (text: string) => void;
}

export interface StreamChatResult {
  inputTokens: number;
  outputTokens: number;
}

/** A tool the model may call (built from connected connector tools). */
export interface ProviderToolDefinition {
  /** Namespaced name, e.g. "notion:list_pages". */
  name: string;
  description: string;
  /** JSON Schema for the tool's input arguments. */
  inputSchema: Record<string, unknown>;
}

export interface ProviderToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolDecisionOptions {
  system?: string;
  messages: ChatMessageInput[];
  tools: ProviderToolDefinition[];
  signal: AbortSignal;
  maxTokens?: number;
}

export interface ToolDecisionResult {
  toolCalls: ProviderToolCall[];
}

export interface ChatProvider {
  id: ProviderId | "demo" | "free";
  model: string;
  streamChat(options: StreamChatOptions): Promise<StreamChatResult>;
  /**
   * Step 6: one NON-STREAMING tool-decision call through the provider's
   * native tools API (no prompt-hacking). Absent on providers without tool
   * support (demo). The chat connector tool loop is the only caller.
   */
  decideToolCalls?(options: ToolDecisionOptions): Promise<ToolDecisionResult>;
}
