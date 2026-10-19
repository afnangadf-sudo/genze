// Memory API client: the user-managed things Genze remembers.
// Every route comes from API_ROUTES (@genze/shared) — never hardcoded.

import { API_ROUTES, type UserMemory } from "@genze/shared";
import { apiFetch } from "./auth";

export async function listMemories(): Promise<UserMemory[]> {
  const data = await apiFetch<{ memories: UserMemory[] }>(API_ROUTES.memories);
  return data.memories;
}

export async function addMemory(content: string): Promise<UserMemory> {
  const data = await apiFetch<{ memory: UserMemory }>(API_ROUTES.memories, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  return data.memory;
}

export async function updateMemory(id: string, content: string): Promise<UserMemory> {
  const data = await apiFetch<{ memory: UserMemory }>(API_ROUTES.memoryItem(id), {
    method: "PATCH",
    body: JSON.stringify({ content }),
  });
  return data.memory;
}

export async function deleteMemory(id: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.memoryItem(id), { method: "DELETE" });
}

/** Forget everything. Returns how many memories were removed. */
export async function forgetAllMemories(): Promise<number> {
  const data = await apiFetch<{ deleted: number }>(API_ROUTES.memories, { method: "DELETE" });
  return data.deleted;
}
