// Project API client: list, create, update, delete.
// Every route comes from API_ROUTES (@genze/shared) — never hardcoded.

import { API_ROUTES, type Project } from "@genze/shared";
import { apiFetch } from "./auth";

export async function listProjects(): Promise<Project[]> {
  const data = await apiFetch<{ projects: Project[] }>(API_ROUTES.projects);
  return data.projects;
}

export async function createProject(title: string, instructions?: string): Promise<Project> {
  const data = await apiFetch<{ project: Project }>(API_ROUTES.projects, {
    method: "POST",
    body: JSON.stringify({ title, ...(instructions ? { instructions } : {}) }),
  });
  return data.project;
}

export async function updateProject(
  id: string,
  patch: { title?: string; instructions?: string; defaultStyleId?: string | null }
): Promise<Project> {
  const data = await apiFetch<{ project: Project }>(API_ROUTES.project(id), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return data.project;
}

export async function deleteProject(id: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.project(id), { method: "DELETE" });
}
