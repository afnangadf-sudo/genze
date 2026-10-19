// File API client: upload (with progress), list, get, signed link, delete.
// Every route comes from API_ROUTES (@genze/shared) — never hardcoded.

import { API_ROUTES, type ApiErrorBody, type ApiResponse, type GenzeFile } from "@genze/shared";
import { API_BASE, ApiClientError, apiFetch, getTokens } from "./auth";

/**
 * Upload a file with progress. Uses XMLHttpRequest because fetch has no
 * upload-progress events. On failure the API's plain-language error message
 * becomes an ApiClientError (callers show `err.message` inline).
 */
export function uploadFile(
  file: File,
  projectId?: string,
  onProgress?: (pct: number) => void
): Promise<GenzeFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}${API_ROUTES.files}`);
    const { access } = getTokens();
    if (access) xhr.setRequestHeader("Authorization", `Bearer ${access}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      let json: ApiResponse<{ file: GenzeFile }> | { error?: ApiErrorBody } | null = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = (json as ApiResponse<{ file: GenzeFile }> | null)?.data;
        if (data?.file) {
          resolve(data.file);
        } else {
          reject(new ApiClientError("UNKNOWN", `Request failed (${xhr.status})`, xhr.status));
        }
        return;
      }
      const err = (json as { error?: ApiErrorBody } | null)?.error;
      reject(
        new ApiClientError(
          err?.code ?? "UNKNOWN",
          err?.message ?? `Request failed (${xhr.status})`,
          xhr.status,
          err?.details
        )
      );
    };
    xhr.onerror = () => {
      reject(new ApiClientError("NETWORK_ERROR", "NETWORK_ERROR", 0));
    };

    const form = new FormData();
    form.append("file", file);
    if (projectId) form.append("projectId", projectId);
    xhr.send(form);
  });
}

export async function listFiles(projectId?: string): Promise<GenzeFile[]> {
  const path =
    API_ROUTES.files + (projectId ? `?projectId=${encodeURIComponent(projectId)}` : "");
  const data = await apiFetch<{ files: GenzeFile[] }>(path);
  return data.files;
}

export async function getFile(id: string): Promise<GenzeFile> {
  const data = await apiFetch<{ file: GenzeFile }>(API_ROUTES.file(id));
  return data.file;
}

/** Signed download URL, prefixed with the API base (GET /files/:id/link). */
export async function downloadUrl(id: string): Promise<string> {
  const data = await apiFetch<{ url: string }>(API_ROUTES.fileLink(id));
  return `${API_BASE}${data.url}`;
}

export async function deleteFile(id: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.file(id), { method: "DELETE" });
}
