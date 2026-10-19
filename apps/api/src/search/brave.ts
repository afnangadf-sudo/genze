// Brave Search provider (REST).
// https://brave.com/search/api/ — GET /res/v1/web/search, header X-Subscription-Token.

import type { SearchProvider, SearchResult } from "./types.js";

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";

interface BraveHit {
  title?: string;
  url?: string;
  description?: string;
}

export function makeBraveProvider(): SearchProvider {
  return {
    id: "brave",
    isConfigured(): boolean {
      return !!process.env.BRAVE_SEARCH_API_KEY;
    },
    async search(query: string, opts?: { maxResults?: number }): Promise<SearchResult[]> {
      const key = process.env.BRAVE_SEARCH_API_KEY;
      if (!key) throw new Error("Brave Search is not configured.");
      const count = Math.min(Math.max(opts?.maxResults ?? 5, 1), 10);
      const url = `${BRAVE_URL}?q=${encodeURIComponent(query)}&count=${count}&text_decorations=false`;
      const res = await fetch(url, { headers: { "X-Subscription-Token": key } });
      if (!res.ok) throw new Error(`Brave search failed (HTTP ${res.status}).`);
      const data = (await res.json()) as { web?: { results?: BraveHit[] } };
      return (data.web?.results ?? [])
        .filter((h) => typeof h.url === "string" && h.url.length > 0)
        .slice(0, count)
        .map((h) => ({
          title: h.title ?? h.url ?? "",
          url: h.url as string,
          snippet: (h.description ?? "").slice(0, 500),
        }));
    },
  };
}
