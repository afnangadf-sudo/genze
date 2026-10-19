// Tavily search provider (REST, no SDK — zero extra deps).
// https://docs.tavily.com/documentation/api-reference/endpoint/search
const TAVILY_URL = "https://api.tavily.com/search";
export function makeTavilyProvider() {
    return {
        id: "tavily",
        isConfigured() {
            return !!process.env.TAVILY_API_KEY;
        },
        async search(query, opts) {
            const key = process.env.TAVILY_API_KEY;
            if (!key)
                throw new Error("Tavily is not configured.");
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
            if (!res.ok)
                throw new Error(`Tavily search failed (HTTP ${res.status}).`);
            const data = (await res.json());
            return (data.results ?? [])
                .filter((h) => typeof h.url === "string" && h.url.length > 0)
                .slice(0, maxResults)
                .map((h) => ({
                title: h.title ?? h.url ?? "",
                url: h.url,
                snippet: (h.content ?? "").slice(0, 500),
            }));
        },
    };
}
//# sourceMappingURL=tavily.js.map