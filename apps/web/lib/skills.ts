// Skills API client: user's skills (CRUD, with built-ins read-only) plus
// attaching skills to projects and chat threads. Every route comes from
// API_ROUTES (@genze/shared) — never hardcoded.

import { API_ROUTES, type Skill } from "@genze/shared";
import { apiFetch } from "./auth";

export interface SkillInput {
  name: string;
  description: string;
  instructions: string;
  scripts: string[];
}

/** Built-ins first, then the user's own skills. */
export async function listSkills(): Promise<Skill[]> {
  const data = await apiFetch<{ skills: Skill[] }>(API_ROUTES.skills);
  return data.skills;
}

export async function getSkill(id: string): Promise<Skill> {
  const data = await apiFetch<{ skill: Skill }>(API_ROUTES.skill(id));
  return data.skill;
}

export async function createSkill(input: SkillInput): Promise<Skill> {
  const data = await apiFetch<{ skill: Skill }>(API_ROUTES.skills, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.skill;
}

export async function updateSkill(id: string, input: Partial<SkillInput>): Promise<Skill> {
  const data = await apiFetch<{ skill: Skill }>(API_ROUTES.skill(id), {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return data.skill;
}

export async function deleteSkill(id: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.skill(id), { method: "DELETE" });
}

/* ---------- attached to projects ---------- */

export async function getProjectSkills(projectId: string): Promise<Skill[]> {
  const data = await apiFetch<{ skills: Skill[] }>(API_ROUTES.projectSkills(projectId));
  return data.skills;
}

export async function attachSkillToProject(projectId: string, skillId: string): Promise<void> {
  await apiFetch(API_ROUTES.projectSkills(projectId), {
    method: "POST",
    body: JSON.stringify({ skillId }),
  });
}

export async function detachSkillFromProject(projectId: string, skillId: string): Promise<void> {
  await apiFetch(API_ROUTES.projectSkill(projectId, skillId), { method: "DELETE" });
}

/* ---------- attached to chat threads ---------- */

export async function getThreadSkills(threadId: string): Promise<Skill[]> {
  const data = await apiFetch<{ skills: Skill[] }>(API_ROUTES.threadSkills(threadId));
  return data.skills;
}

export async function attachSkillToThread(threadId: string, skillId: string): Promise<void> {
  await apiFetch(API_ROUTES.threadSkills(threadId), {
    method: "POST",
    body: JSON.stringify({ skillId }),
  });
}

export async function detachSkillFromThread(threadId: string, skillId: string): Promise<void> {
  await apiFetch(API_ROUTES.threadSkill(threadId, skillId), { method: "DELETE" });
}
