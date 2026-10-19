// Write API client: drafts, revise, fact-check, exports, styles.
// Every route comes from API_ROUTES (@genze/shared) — never hardcoded.

import {
  API_ROUTES,
  type FactCheck,
  type ReviseAction,
  type WriteDraft,
  type WriteTemplate,
  type WritingStyle,
} from "@genze/shared";
import { API_BASE, ApiClientError, apiFetch, getTokens } from "./auth";

export interface CreateDraftInput {
  template: WriteTemplate;
  brief: string;
  projectId?: string;
  styleId?: string;
}

export async function createDraft(input: CreateDraftInput): Promise<WriteDraft> {
  const body: { template: WriteTemplate; brief: string; projectId?: string; styleId?: string } = {
    template: input.template,
    brief: input.brief,
  };
  if (input.projectId) body.projectId = input.projectId;
  if (input.styleId) body.styleId = input.styleId;
  const data = await apiFetch<{ draft: WriteDraft }>(API_ROUTES.writeDrafts, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.draft;
}

export async function listDrafts(): Promise<WriteDraft[]> {
  const data = await apiFetch<{ drafts: WriteDraft[] }>(API_ROUTES.writeDrafts);
  return data.drafts;
}

export async function getDraft(id: string): Promise<WriteDraft> {
  const data = await apiFetch<{ draft: WriteDraft }>(API_ROUTES.writeDraft(id));
  return data.draft;
}

export async function updateDraft(
  id: string,
  patch: { title?: string; content?: string }
): Promise<WriteDraft> {
  const data = await apiFetch<{ draft: WriteDraft }>(API_ROUTES.writeDraft(id), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return data.draft;
}

export async function deleteDraft(id: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.writeDraft(id), { method: "DELETE" });
}

/** Returns the revised text only — the caller decides whether to persist it. */
export async function reviseDraft(id: string, action: ReviseAction): Promise<string> {
  const data = await apiFetch<{ revised: string }>(API_ROUTES.writeDraftRevise(id), {
    method: "POST",
    body: JSON.stringify({ action }),
  });
  return data.revised;
}

export async function startFactCheck(draftId: string): Promise<FactCheck> {
  const data = await apiFetch<{ check: FactCheck }>(API_ROUTES.writeDraftFactCheck(draftId), {
    method: "POST",
    body: JSON.stringify({}),
  });
  return data.check;
}

export async function getFactCheck(id: string): Promise<FactCheck> {
  const data = await apiFetch<{ check: FactCheck }>(API_ROUTES.writeFactCheck(id));
  return data.check;
}

/** Download a draft export (docx/pdf/xlsx/pptx) via the authenticated GET route. */
export async function downloadDraftExport(
  id: string,
  format: "docx" | "pdf" | "xlsx" | "pptx",
  filename: string
): Promise<void> {
  const { access } = getTokens();
  const res = await fetch(`${API_BASE}${API_ROUTES.writeDraftExport(id)}?format=${format}`, {
    headers: access ? { Authorization: `Bearer ${access}` } : {},
  });
  if (!res.ok) {
    let body: { error?: { code?: string; message?: string } } | null = null;
    try {
      body = (await res.json()) as { error?: { code?: string; message?: string } };
    } catch {
      /* not JSON */
    }
    throw new ApiClientError(
      body?.error?.code ?? "UNKNOWN",
      body?.error?.message ?? `Request failed (${res.status})`,
      res.status
    );
  }
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/* ---------- writing styles ---------- */

export async function listStyles(): Promise<WritingStyle[]> {
  const data = await apiFetch<{ styles: WritingStyle[] }>(API_ROUTES.writeStyles);
  return data.styles;
}

export async function createStyle(name: string, description: string): Promise<WritingStyle> {
  const data = await apiFetch<{ style: WritingStyle }>(API_ROUTES.writeStyles, {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });
  return data.style;
}

export async function updateStyle(
  id: string,
  patch: { name?: string; description?: string }
): Promise<WritingStyle> {
  const data = await apiFetch<{ style: WritingStyle }>(API_ROUTES.writeStyle(id), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return data.style;
}

export async function deleteStyle(id: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.writeStyle(id), { method: "DELETE" });
}
