// Skills service (Step 6): row mapping, validation, and the system-prompt
// block appended to threaded chat (after project instructions, before memory).

import type { Skill } from "@genze/shared";
import { getPool } from "../db.js";

export interface DbSkill {
  id: string;
  user_id: string | null;
  name: string;
  description: string;
  instructions: string;
  scripts: unknown;
  is_builtin: boolean;
  created_at: Date;
  updated_at: Date;
}

export const SKILL_COLUMNS =
  "id, user_id, name, description, instructions, scripts, is_builtin, created_at, updated_at";

export function toSkill(row: DbSkill): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    instructions: row.instructions ?? "",
    scripts: Array.isArray(row.scripts) ? (row.scripts as string[]) : [],
    builtin: row.is_builtin,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_SCRIPTS = 20;
const MAX_SCRIPT_CHARS = 2000;

export interface SkillInput {
  name: string;
  description: string;
  instructions: string;
  scripts: string[];
}

/** Validate a skill body; returns the normalized input or a plain message. */
export function validateSkillInput(
  body: Record<string, unknown>,
  partial: boolean,
): { ok: true; input: Partial<SkillInput> } | { ok: false; message: string } {
  const input: Partial<SkillInput> = {};
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
  if (body.scripts !== undefined) {
    if (
      !Array.isArray(body.scripts) ||
      body.scripts.length > MAX_SCRIPTS ||
      body.scripts.some((s) => typeof s !== "string" || s.length > MAX_SCRIPT_CHARS)
    ) {
      return { ok: false, message: "Scripts must be an array of at most 20 strings (2000 chars each)." };
    }
    input.scripts = [...(body.scripts as string[])];
  } else if (!partial) {
    input.scripts = [];
  }
  return { ok: true, input };
}

/** A skill the user may see: a built-in, or one they own. */
export async function getVisibleSkill(userId: string, skillId: string): Promise<DbSkill | null> {
  if (!UUID_RE.test(skillId)) return null;
  const r = await getPool().query<DbSkill>(
    `SELECT ${SKILL_COLUMNS} FROM skills WHERE id = $1 AND (user_id IS NULL OR user_id = $2)`,
    [skillId, userId],
  );
  return r.rowCount ? r.rows[0] : null;
}

/**
 * System-prompt block for the skills attached to a thread, its project, and
 * (optionally) its gem, deduped by skill id. Empty string when none are
 * attached.
 * Contract shape: `[Skills in use:\n- <name>: <instructions>]`.
 */
export async function buildSkillsBlock(
  userId: string,
  threadId: string,
  projectId: string | null,
  gemId?: string | null,
): Promise<string> {
  const r = await getPool().query<{ name: string; instructions: string }>(
    `SELECT DISTINCT s.name, s.instructions
     FROM skills s
     LEFT JOIN thread_skills ts ON ts.skill_id = s.id AND ts.thread_id = $2
     LEFT JOIN project_skills ps ON ps.skill_id = s.id AND ps.project_id = $3
     LEFT JOIN gem_skills gs ON gs.skill_id = s.id AND gs.gem_id = $4
     WHERE (ts.thread_id IS NOT NULL OR ps.project_id IS NOT NULL OR gs.gem_id IS NOT NULL)
       AND (s.user_id IS NULL OR s.user_id = $1)
       AND NULLIF(btrim(s.instructions), '') IS NOT NULL
     ORDER BY s.name ASC`,
    [userId, threadId, projectId, gemId ?? null],
  );
  if (!r.rowCount) return "";
  const lines = r.rows.map((s) => `- ${s.name}: ${s.instructions.trim()}`);
  return `[Skills in use:\n${lines.join("\n")}]`;
}
