// Gems API client: shareable custom assistants (CRUD, share links, cloning
// from a share link) plus attaching skills and files to a gem. Every route
// comes from API_ROUTES (@genze/shared) — never hardcoded.

import { API_ROUTES, type Gem, type GenzeFile, type Skill } from "@genze/shared";
import { apiFetch } from "./auth";

export interface GemInput {
  name: string;
  description: string;
  instructions: string;
  starterPrompts: string[];
  /** Optional model preference — never shown in the UI, only sent to the API. */
  modelPreference: string | null;
  skillIds?: string[];
  fileIds?: string[];
}

/** Visible gems: built-ins first, then the user's own. */
export async function listGems(): Promise<Gem[]> {
  const data = await apiFetch<{ gems: Gem[] }>(API_ROUTES.gems);
  return data.gems;
}

export async function getGem(id: string): Promise<Gem> {
  const data = await apiFetch<{ gem: Gem }>(API_ROUTES.gem(id));
  return data.gem;
}

export async function createGem(input: GemInput): Promise<Gem> {
  const data = await apiFetch<{ gem: Gem }>(API_ROUTES.gems, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.gem;
}

export async function updateGem(id: string, input: Partial<GemInput>): Promise<Gem> {
  const data = await apiFetch<{ gem: Gem }>(API_ROUTES.gem(id), {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return data.gem;
}

export async function deleteGem(id: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.gem(id), { method: "DELETE" });
}

/* ---------- sharing ---------- */

/**
 * Shares an own gem: generates the share link (idempotent — an active link
 * is returned as-is). Built-ins refuse with a 400 (they're already public).
 */
export async function shareGem(id: string): Promise<string> {
  const data = await apiFetch<{ shareUrl: string }>(API_ROUTES.gemShare(id), {
    method: "POST",
  });
  return data.shareUrl;
}

/** Revokes a gem's share link. Existing copies keep working (independent rows). */
export async function revokeGemShare(id: string): Promise<void> {
  await apiFetch<{ revoked: boolean }>(API_ROUTES.gemShare(id), { method: "DELETE" });
}

/**
 * Adds a shared gem to the caller's account via its share token. The copy is
 * an independent gem: instructions are copied, the owner's skills/files are not.
 */
export async function cloneSharedGem(token: string): Promise<Gem> {
  const data = await apiFetch<{ gem: Gem }>(API_ROUTES.gemSharedClone(token), {
    method: "POST",
  });
  return data.gem;
}

/* ---------- skills attached to a gem ---------- */

export async function listGemSkills(id: string): Promise<Skill[]> {
  const data = await apiFetch<{ skills: Skill[] }>(API_ROUTES.gemSkills(id));
  return data.skills;
}

export async function attachSkillToGem(gemId: string, skillId: string): Promise<void> {
  await apiFetch(API_ROUTES.gemSkills(gemId), {
    method: "POST",
    body: JSON.stringify({ skillId }),
  });
}

export async function detachSkillFromGem(gemId: string, skillId: string): Promise<void> {
  await apiFetch(API_ROUTES.gemSkill(gemId, skillId), { method: "DELETE" });
}

/* ---------- files attached to a gem ---------- */

export async function listGemFiles(id: string): Promise<GenzeFile[]> {
  const data = await apiFetch<{ files: GenzeFile[] }>(API_ROUTES.gemFiles(id));
  return data.files;
}

export async function attachFileToGem(gemId: string, fileId: string): Promise<void> {
  await apiFetch(API_ROUTES.gemFiles(gemId), {
    method: "POST",
    body: JSON.stringify({ fileId }),
  });
}

export async function detachFileFromGem(gemId: string, fileId: string): Promise<void> {
  await apiFetch(API_ROUTES.gemFile(gemId, fileId), { method: "DELETE" });
}
