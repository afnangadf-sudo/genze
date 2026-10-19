// Gems service (chat polish): row mapping, validation, visibility, and the
// system-prompt block appended to threaded chat when a thread uses a gem.

import type { Gem } from "@genze/shared";
import { getPool } from "../db.js";
import { findChatModel } from "../providers/models.js";

export interface DbGem {
  id: string;
  user_id: string | null;
  name: string;
  description: string;
  instructions: string;
  starter_prompts: unknown;
  model_preference: string | null;
  share_token: string | null;
  copied_from: string | null;
  created_at: Date;
  updated_at: Date;
}

export const GEM_COLUMNS =
  "id, user_id, name, description, instructions, starter_prompts, model_preference, share_token, copied_from, created_at, updated_at";

/**
 * Map a gem row to the API shape. `shareUrl` is only ever set through opts
 * (the share endpoint); every other read leaves it null so share links
 * never leak, and `modelPreference` is never exposed in any response — it
 * is a hidden routing hint, not something the UI shows.
 */
export function toGem(row: DbGem, opts?: { shareUrl?: string }): Gem {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    instructions: row.instructions ?? "",
    starterPrompts: Array.isArray(row.starter_prompts) ? (row.starter_prompts as string[]) : [],
    modelPreference: null,
    builtin: row.user_id === null,
    copiedFrom: row.copied_from,
    shareUrl: opts?.shareUrl ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GemInput {
  name: string;
  description: string;
  instructions: string;
  starterPrompts: string[];
  modelPreference: string | null;
}

/** Validate a gem body; returns the normalized input or a plain message. */
export function validateGemInput(
  body: Record<string, unknown>,
  partial: boolean,
): { ok: true; input: Partial<GemInput> } | { ok: false; message: string } {
  const input: Partial<GemInput> = {};
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 80) {
      return { ok: false, message: "Name must be 1–80 characters." };
    }
    input.name = name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.length > 500) {
      return { ok: false, message: "Description must be at most 500 characters." };
    }
    input.description = body.description;
  } else if (!partial) {
    input.description = "";
  }
  if (body.instructions !== undefined || !partial) {
    const instructions = typeof body.instructions === "string" ? body.instructions : "";
    if (instructions.length < 1 || instructions.length > 8000) {
      return { ok: false, message: "Instructions must be 1–8000 characters." };
    }
    input.instructions = instructions;
  }
  if (body.starterPrompts !== undefined) {
    if (
      !Array.isArray(body.starterPrompts) ||
      body.starterPrompts.length > 4 ||
      body.starterPrompts.some(
        (s) => typeof s !== "string" || s.trim().length < 1 || s.length > 200,
      )
    ) {
      return { ok: false, message: "Starter prompts must be up to 4 texts of 1–200 characters." };
    }
    input.starterPrompts = (body.starterPrompts as string[]).map((s) => s.trim());
  } else if (!partial) {
    input.starterPrompts = [];
  }
  if (body.modelPreference !== undefined) {
    if (body.modelPreference !== null) {
      if (typeof body.modelPreference !== "string" || !findChatModel(body.modelPreference)) {
        return { ok: false, message: "That model choice isn't available." };
      }
      input.modelPreference = body.modelPreference;
    } else {
      input.modelPreference = null;
    }
  } else if (!partial) {
    input.modelPreference = null;
  }
  return { ok: true, input };
}

/** A gem the user may see: a built-in, or one they own. */
export async function getVisibleGem(userId: string, gemId: string): Promise<DbGem | null> {
  if (!UUID_RE.test(gemId)) return null;
  const r = await getPool().query<DbGem>(
    `SELECT ${GEM_COLUMNS} FROM gems WHERE id = $1 AND (user_id IS NULL OR user_id = $2)`,
    [gemId, userId],
  );
  return r.rowCount ? r.rows[0] : null;
}

/** A gem the user owns (built-ins excluded). */
export async function getOwnedGem(userId: string, gemId: string): Promise<DbGem | null> {
  if (!UUID_RE.test(gemId)) return null;
  const r = await getPool().query<DbGem>(`SELECT ${GEM_COLUMNS} FROM gems WHERE id = $1 AND user_id = $2`, [
    gemId,
    userId,
  ]);
  return r.rowCount ? r.rows[0] : null;
}

/**
 * The system-prompt block for a thread's gem. Empty string when the gem
 * has no instructions. Contract shape: `[Assistant "<name>":\n<instructions>]`.
 */
export function buildGemBlock(gem: DbGem): string {
  const instructions = (gem.instructions ?? "").trim();
  if (!instructions) return "";
  return `[Assistant "${gem.name}":\n${instructions}]`;
}
