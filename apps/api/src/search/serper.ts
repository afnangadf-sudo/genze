// Serper (Google SERP) provider (REST).
// https://serper.dev/ — POST /search, header X-API-KEY.

import type { SearchProvider, SearchResult } from "./types.js";

const SERPER_URL = "https://google.serper.dev/search";

interface SerperHit {
  title?: string;
  link?: string;
  snippet?: string;
}

export function makeSerperProvider(): SearchProvider {
  return {
    id: "serper",
    isConfigured(): boolean {
      return !!process.env.SERPER_API_KEY;
    },
    async search(query: string, opts?: { maxResults?: number }): Promise<SearchResult[]> {
      const key = process.env.SERPER_API_KEY;
      if (!key) throw new Error("Serper is not configured.");
      const num = Math.min(Math.max(opts?.maxResults ?? 5, 1), 10);
      const res = await fetch(SERPER_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "X-API-KEY": key },
        body: JSON.stringify({ q: query, num }),
      });
      if (!res.ok) throw new Error(`Serper search failed (HTTP ${res.status}).`);
      const data = (await res.json()) as { organic?: SerperHit[] };
      return (data.organic ?? [])
        .filter((h) => typeof h.link === "string" && h.link.length > 0)
        .slice(0, num)
        .map((h) => ({
          title: h.title ?? h.link ?? "",
          url: h.link as string,
          snippet: (h.snippet ?? "").slice(0, 500),
        }));
    },
  };
}
