// pickSearchProvider(): the single selection point for web search.
//
// SEARCH_PROVIDER (tavily|brave|serper|stub, default tavily) names the
// provider; null when its key is missing — the routes map that to
// 503 SEARCH_NOT_CONFIGURED (never a fake result). `stub` is honored only
// when NODE_ENV=test.

import type { SearchProvider, SearchProviderId } from "./types.js";
import { makeTavilyProvider } from "./tavily.js";
import { makeBraveProvider } from "./brave.js";
import { makeSerperProvider } from "./serper.js";
import { makeStubProvider } from "./stub.js";

export type { SearchProvider, SearchProviderId, SearchResult } from "./types.js";

const PROVIDER_IDS: SearchProviderId[] = ["tavily", "brave", "serper", "stub"];

function make(id: SearchProviderId): SearchProvider {
  switch (id) {
    case "tavily":
      return makeTavilyProvider();
    case "brave":
      return makeBraveProvider();
    case "serper":
      return makeSerperProvider();
    case "stub":
      return makeStubProvider();
  }
}

export function pickSearchProvider(): SearchProvider | null {
  const raw = (process.env.SEARCH_PROVIDER ?? "tavily").trim().toLowerCase();
  const id: SearchProviderId = (PROVIDER_IDS as string[]).includes(raw)
    ? (raw as SearchProviderId)
    : "tavily";
  if (id === "stub" && process.env.NODE_ENV !== "test") return null;
  const provider = make(id);
  return provider.isConfigured() ? provider : null;
}
