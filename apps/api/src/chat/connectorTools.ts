// Bounded connector tool loop for threaded chat (Step 6).
//
// Runs BEFORE the final answer streams, inside runChatStream's preStream
// hook (so the SSE `start` event keeps its position and heartbeats cover the
// MCP round-trips). Contract: CONTRACTS.md "Chat + connector tools".
//
// Boundaries (all enforced here):
// - Only on threaded chat with a real provider: never temp chat, never demo
//   mode, never lockdown threads (the caller gates on chatAugmentations()).
// - ONE non-streaming tool-decision call through the routed provider.
// - At most 3 read-only tool calls execute directly (metered as
//   feature='connector_tool' by the connector manager itself).
// - A requested WRITE tool never executes here: the stream ends with a
//   terminal `confirmation_required` SSE event, no assistant message is
//   persisted, nothing is executed.
// - Tool results enter context wrapped in the labeled untrusted-data block.

import type {
  ChatConfirmationRequiredEvent,
  ChatToolActivityEvent,
  ConnectorConfirmation,
  ConnectorId,
} from "@genze/shared";
import {
  ConnectorError,
  callTool,
  confirmPendingWrite,
  listTools,
  wrapConnectorData,
} from "../connectors/manager.js";
import { getDefinition } from "../connectors/registry.js";
import type {
  ChatMessageInput,
  ChatProvider,
  ProviderToolDefinition,
} from "../providers/chatProvider.js";

export type ConnectorStreamEvent = ChatToolActivityEvent | ChatConfirmationRequiredEvent;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONNECTOR_IDS: ConnectorId[] = [
  "google-drive",
  "gmail",
  "google-calendar",
  "notion",
  "slack",
  "github",
  "dropbox",
  "onedrive",
];

/** At most this many read-only tool calls execute per reply. */
const MAX_TOOL_CALLS = 3;

function displayName(connectorId: string): string {
  return getDefinition(connectorId)?.name ?? connectorId;
}

function isValidConnectorId(id: string): id is ConnectorId {
  return (CONNECTOR_IDS as string[]).includes(id);
}

/** Validate the `useConnectors` body field. Absent/empty → no-op. */
export function parseUseConnectors(raw: unknown):
  | { ok: true; ids: ConnectorId[] }
  | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (
    !Array.isArray(raw) ||
    raw.some((c) => typeof c !== "string" || !isValidConnectorId(c))
  ) {
    return { ok: false, message: "useConnectors must be an array of connector ids." };
  }
  return { ok: true, ids: [...new Set(raw as ConnectorId[])] };
}

/** Validate the `confirmedActions` body field. Absent → no-op. */
export function parseConfirmedActions(raw: unknown):
  | { ok: true; ids: string[] }
  | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (
    !Array.isArray(raw) ||
    raw.some(
      (a) =>
        typeof a !== "object" ||
        a === null ||
        typeof (a as { confirmationId?: unknown }).confirmationId !== "string" ||
        !UUID_RE.test((a as { confirmationId: string }).confirmationId),
    )
  ) {
    return { ok: false, message: "confirmedActions must be an array of { confirmationId }." };
  }
  return { ok: true, ids: (raw as Array<{ confirmationId: string }>).map((a) => a.confirmationId) };
}

export interface ToolLoopOutcome {
  /** True when the stream must end now: no assistant message is persisted. */
  halt: boolean;
  /** Extra system context (labeled untrusted tool-result blocks). */
  extraSystem: string;
  /** Fatal plain-language failure: the caller emits it as an SSE error event. */
  fatalError?: { code: string; message: string };
}

interface NamespacedTool extends ProviderToolDefinition {
  connectorId: ConnectorId;
  toolName: string;
  readOnly: boolean;
}

function isConfirmationRequired(
  res: unknown,
): res is { confirmationRequired: true; confirmation: ConnectorConfirmation } {
  return (
    typeof res === "object" &&
    res !== null &&
    (res as { confirmationRequired?: unknown }).confirmationRequired === true
  );
}

export async function runConnectorToolLoop(opts: {
  userId: string;
  connectorIds: ConnectorId[];
  confirmedActionIds: string[];
  provider: ChatProvider;
  providerId: string;
  system: string;
  history: ChatMessageInput[];
  signal: AbortSignal;
  sendEvent: (event: ConnectorStreamEvent) => void;
}): Promise<ToolLoopOutcome> {
  const extraBlocks: string[] = [];

  // Phase 1 — confirmed writes (the client re-posted after a confirmation
  // card). Each executes through the connector manager, which validates the
  // pending row (user/connector/tool/args, unexpired) before running it.
  for (const confirmationId of opts.confirmedActionIds) {
    opts.sendEvent({ type: "tool_activity", message: "Doing that now…" });
    try {
      const result = await confirmPendingWrite(opts.userId, confirmationId);
      extraBlocks.push(wrapConnectorData("your connected app", result));
    } catch (err) {
      if (err instanceof ConnectorError) {
        return {
          halt: true,
          extraSystem: "",
          fatalError: { code: err.code, message: err.message },
        };
      }
      return {
        halt: true,
        extraSystem: "",
        fatalError: {
          code: "CONNECTOR_ERROR",
          message: "That action couldn't be completed. Please try again.",
        },
      };
    }
  }

  // Phase 2 — fresh tool decisions. Needs the provider's non-streaming
  // tool-decision call; without it (or without connectors) there is nothing
  // to do.
  if (opts.connectorIds.length === 0 || typeof opts.provider.decideToolCalls !== "function") {
    return { halt: false, extraSystem: extraBlocks.join("\n\n") };
  }

  // Build tool definitions from the CONNECTED connectors only. A connector
  // that isn't connected (or can't be reached) is skipped silently.
  const defs: NamespacedTool[] = [];
  for (const connectorId of opts.connectorIds) {
    let tools;
    try {
      tools = await listTools(opts.userId, connectorId);
    } catch {
      continue;
    }
    for (const t of tools) {
      defs.push({
        name: `${connectorId}:${t.name}`,
        description: `${displayName(connectorId)} — ${t.description}${t.readOnly ? "" : " (needs your confirmation before it runs)"}`,
        // ConnectorToolInfo carries no input schema (frozen shared type);
        // the manager may attach one at runtime, else a generic object.
        inputSchema: (t as { inputSchema?: Record<string, unknown> }).inputSchema ?? {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
        connectorId,
        toolName: t.name,
        readOnly: t.readOnly,
      });
    }
  }
  if (defs.length === 0) {
    return { halt: false, extraSystem: extraBlocks.join("\n\n") };
  }

  opts.sendEvent({ type: "tool_activity", message: "Checking your connected apps…" });

  let toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  try {
    const decision = await opts.provider.decideToolCalls({
      system:
        `${opts.system}\n\n` +
        `[Tool use: you can use the user's connected apps through the tools listed. ` +
        `Only call a tool when the request genuinely needs live data or an action from a connected app — ` +
        `never for things you already know. Prefer read-only tools. ` +
        `If you call a write tool, the reply pauses for the user's confirmation, so only do that when the user clearly asked for an action. ` +
        `Make at most ${MAX_TOOL_CALLS} tool calls.]`,
      messages: opts.history,
      tools: defs,
      signal: opts.signal,
    });
    toolCalls = decision.toolCalls;
  } catch {
    // The decision call failed: answer without tools rather than failing the
    // whole reply.
    opts.sendEvent({
      type: "tool_activity",
      message: "Couldn't reach your connected apps — answering without them.",
    });
    return { halt: false, extraSystem: extraBlocks.join("\n\n") };
  }

  let executed = 0;
  for (const call of toolCalls) {
    const def =
      defs.find((d) => d.name === call.name) ??
      (() => {
        const bare = defs.filter((d) => d.toolName === call.name);
        return bare.length === 1 ? bare[0] : undefined;
      })();
    if (!def) continue; // the model named a tool that doesn't exist — ignore
    const args =
      call.input && typeof call.input === "object" ? call.input : ({} as Record<string, unknown>);

    if (!def.readOnly) {
      // WRITE tool: never execute here. Ask the manager for the confirmation
      // payload (it stores the pending row, executes nothing) and end the
      // stream — the client shows the confirmation card.
      const res = await callTool(opts.userId, def.connectorId, def.toolName, args);
      if (isConfirmationRequired(res)) {
        opts.sendEvent({ type: "confirmation_required", confirmation: res.confirmation });
        return { halt: true, extraSystem: extraBlocks.join("\n\n") };
      }
      // Unexpected: the manager executed it. Fold the result in and stop —
      // the reply continues normally below.
      extraBlocks.push(wrapConnectorData(displayName(def.connectorId), res));
      return { halt: false, extraSystem: extraBlocks.join("\n\n") };
    }

    if (executed >= MAX_TOOL_CALLS) break;
    executed++;
    opts.sendEvent({ type: "tool_activity", message: `Checking your ${displayName(def.connectorId)}…` });
    try {
      const res = await callTool(opts.userId, def.connectorId, def.toolName, args);
      if (isConfirmationRequired(res)) {
        opts.sendEvent({ type: "confirmation_required", confirmation: res.confirmation });
        return { halt: true, extraSystem: extraBlocks.join("\n\n") };
      }
      extraBlocks.push(wrapConnectorData(displayName(def.connectorId), res));
    } catch {
      extraBlocks.push(
        wrapConnectorData(
          displayName(def.connectorId),
          `The ${def.toolName} lookup didn't work. Continuing without it.`,
        ),
      );
    }
  }

  return { halt: false, extraSystem: extraBlocks.join("\n\n") };
}
