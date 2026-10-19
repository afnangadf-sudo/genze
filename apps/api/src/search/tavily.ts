// Tavily search provider (REST, no SDK — zero extra deps).
// https://docs.tavily.com/documentation/api-reference/endpoint/search

import type { SearchProvider, SearchResult } from "./types.js";

const TAVILY_URL = "https://api.tavily.com/search";

interface TavilyHit {
  title?: string;
  url?: string;
  content?: string;
}

export function makeTavilyProvider(): SearchProvider {
  return {
    id: "tavily",
    isConfigured(): boolean {
      return !!process.env.TAVILY_API_KEY;
    },
    async search(query: string, opts?: { maxResults?: number }): Promise<SearchResult[]> {
      const key = process.env.TAVILY_API_KEY;
      if (!key) throw new Error("Tavily is not configured.");
      const maxResults = Math.min(Math.max(opts?.maxResults ?? 5, 1), 10);
      const res = await fetch(TAVILY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          query,
          search_depth: "advanced",
          max_results: maxResults,
          include_answer: false,
        }),
      });
      if (!res.ok) throw new Error(`Tavily search failed (HTTP ${res.status}).`);
      const data = (await res.json()) as { results?: TavilyHit[] };
      return (data.results ?? [])
        .filter((h) => typeof h.url === "string" && h.url.length > 0)
        .slice(0, maxResults)
        .map((h) => ({
          title: h.title ?? h.url ?? "",
          url: h.url as string,
          snippet: (h.content ?? "").slice(0, 500),
        }));
    },
  };
}
