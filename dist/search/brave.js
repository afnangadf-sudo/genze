// Brave Search provider (REST).
// https://brave.com/search/api/ — GET /res/v1/web/search, header X-Subscription-Token.
const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
export function makeBraveProvider() {
    return {
        id: "brave",
        isConfigured() {
            return !!process.env.BRAVE_SEARCH_API_KEY;
        },
        async search(query, opts) {
            const key = process.env.BRAVE_SEARCH_API_KEY;
            if (!key)
                throw new Error("Brave Search is not configured.");
            const count = Math.min(Math.max(opts?.maxResults ?? 5, 1), 10);
            const url = `${BRAVE_URL}?q=${encodeURIComponent(query)}&count=${count}&text_decorations=false`;
            const res = await fetch(url, { headers: { "X-Subscription-Token": key } });
            if (!res.ok)
                throw new Error(`Brave search failed (HTTP ${res.status}).`);
            const data = (await res.json());
            return (data.web?.results ?? [])
                .filter((h) => typeof h.url === "string" && h.url.length > 0)
                .slice(0, count)
                .map((h) => ({
                title: h.title ?? h.url ?? "",
                url: h.url,
                snippet: (h.description ?? "").slice(0, 500),
            }));
        },
    };
}
//# sourceMappingURL=brave.js.map