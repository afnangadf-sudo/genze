// Library API client: search across projects/chats/files (stubs stay empty),
// delete an item by type + id. Every route comes from API_ROUTES
// (@genze/shared) — never hardcoded.

import { API_ROUTES, type LibraryGroup } from "@genze/shared";
import { apiFetch } from "./auth";

export async function searchLibrary(
  q?: string
): Promise<{ groups: LibraryGroup[]; query: string | null }> {
  const path = API_ROUTES.library + (q ? `?q=${encodeURIComponent(q)}` : "");
  const data = await apiFetch<{ groups: LibraryGroup[]; query: string | null }>(path);
  return data;
}

export async function deleteLibraryItem(type: string, id: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.libraryItem(type, id), { method: "DELETE" });
}
