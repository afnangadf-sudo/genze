// Search provider interface (per CONTRACTS.md Step 4).
// Tavily is the default; Brave/Serper sit behind the same interface
// (swappable via SEARCH_PROVIDER). `stub` is test-only canned results.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchProviderId = "tavily" | "brave" | "serper" | "stub";

export interface SearchProvider {
  id: SearchProviderId;
  /** Key present in env (stub: always true, but only honored in tests). */
  isConfigured(): boolean;
  search(query: string, opts?: { maxResults?: number }): Promise<SearchResult[]>;
}
