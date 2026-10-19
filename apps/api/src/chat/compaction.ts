// Thread compaction: when a thread's uncompacted message text exceeds a
// character budget, the older part is summarized with the SAME provider that
// is answering this request (consent for that provider was already verified
// on the reply path), and the summary is stored on the thread. Subsequent
// replies exclude the compacted messages and prepend the summary to the
// system prompt.
//
// Failure-safe by design: any error anywhere in here is swallowed and the
// function reports {ran:false}. Compaction must never break the user's reply.

import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import type { ChatMessageInput, ChatProvider } from "../providers/chatProvider.js";
import { chatReplyCost, type ModelInfo } from "../providers/models.js";
import { completeWithProvider } from "../providers/complete.js";

/** Stable marker every summarizer prompt must carry (tests key off it). */
export const COMPACTION_SUMMARY_MARKER = "Summarize the earlier part of this conversation";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function compactionTriggerChars(): number {
  return envInt("COMPACTION_TRIGGER_CHARS", 100_000);
}

export function compactionKeepMessages(): number {
  return envInt("COMPACTION_KEEP_MESSAGES", 10);
}

export function compactionSummaryMaxChars(): number {
  return envInt("COMPACTION_SUMMARY_MAX_CHARS", 4000);
}

export interface MaybeCompactArgs {
  userId: string;
  threadId: string;
  provider: ChatProvider;
  /** Provider id string for the metering row ("demo" for demo mode). */
  providerId: string;
  /** Catalog model for the reply, null in demo mode. */
  model: ModelInfo | null;
  demo: boolean;
}

interface DbCompactionRow {
  compaction_summary: string | null;
  compacted_through_message_id: string | null;
}

interface DbMsg {
  id: string;
  created_at: Date;
  role: string;
  content: string;
}

function formatForSummary(messages: DbMsg[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
}

export async function maybeCompactThread(args: MaybeCompactArgs): Promise<{ ran: boolean }> {
  const pool = getPool();
  try {
    // Load the thread's compaction state (must belong to the user).
    const thr = await pool.query<DbCompactionRow>(
      "SELECT compaction_summary, compacted_through_message_id FROM chat_threads WHERE id = $1 AND user_id = $2",
      [args.threadId, args.userId],
    );
    if (!thr.rowCount) return { ran: false };
    const priorSummary = thr.rows[0].compaction_summary;
    const throughId = thr.rows[0].compacted_through_message_id;

    // Messages oldest-first; skip everything already compacted (at or below
    // compacted_through_message_id).
    const msgs = await pool.query<DbMsg>(
      `SELECT id, created_at, role, content FROM chat_messages
       WHERE thread_id = $1 ORDER BY created_at ASC, id ASC`,
      [args.threadId],
    );
    let remaining = msgs.rows;
    if (throughId) {
      const idx = remaining.findIndex((m) => m.id === throughId);
      if (idx >= 0) remaining = remaining.slice(idx + 1);
    }

    const totalChars = remaining.reduce((n, m) => n + m.content.length, 0);
    if (totalChars <= compactionTriggerChars()) return { ran: false };

    // Keep the newest N verbatim; summarize everything older.
    const keep = compactionKeepMessages();
    const olds = remaining.length > keep ? remaining.slice(0, remaining.length - keep) : [];
    if (olds.length === 0) return { ran: false };

    const summaryInput =
      (priorSummary ? `Previous summary of the conversation:\n${priorSummary}\n\n` : "") +
      `Earlier conversation:\n${formatForSummary(olds)}`;

    const system =
      `${COMPACTION_SUMMARY_MARKER}. Write a concise brief, no more than ` +
      `${compactionSummaryMaxChars()} characters. Preserve the key facts, decisions, names, ` +
      `and open questions. Write it in the same language as the conversation. Output only the summary.`;

    const summaryMessages: ChatMessageInput[] = [{ role: "user", content: summaryInput }];
    const { text, inputTokens, outputTokens } = await completeWithProvider(args.provider, {
      system,
      messages: summaryMessages,
    });
    const summary = text.trim().slice(0, compactionSummaryMaxChars());
    if (summary.length === 0) return { ran: false };

    const lastOld = olds[olds.length - 1];
    await pool.query(
      "UPDATE chat_threads SET compaction_summary = $1, compacted_through_message_id = $2, updated_at = now() WHERE id = $3",
      [summary, lastOld.id, args.threadId],
    );

    // Meter the summarizer call like a reply (demo costs 0).
    const cost = args.demo || !args.model ? 0 : chatReplyCost(args.model, inputTokens, outputTokens);
    await pool.query(
      "INSERT INTO usage_events (id, user_id, feature, provider, units, cost_usd) VALUES ($1, $2, 'compaction', $3, $4, $5)",
      [uuidv4(), args.userId, args.providerId, inputTokens + outputTokens, cost],
    );

    return { ran: true };
  } catch {
    // Compaction must never break the reply.
    return { ran: false };
  }
}

/** System-prompt prefix carrying the stored summary into the reply. */
export function compactionSystemPrefix(summary: string): string {
  return `[Earlier in this conversation — summarized:\n${summary}]\n\n`;
}
