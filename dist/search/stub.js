// Stub search provider — TEST ONLY. Returns canned results so the research
// pipeline and fact-check tests run with zero network. Honored by
// pickSearchProvider() only when NODE_ENV=test; anywhere else it is never
// returned (a stubbed "research report" would be a fabricated result).
//
// Tests point the stub at a local HTTP server via setStubResults() so the
// full search → fetch → synthesize path is exercised end to end.
let canned = [
    {
        title: "Stub result one",
        url: "https://example.com/stub-one",
        snippet: "A canned search result used when no canned list was set.",
    },
    {
        title: "Stub result two",
        url: "https://example.com/stub-two",
        snippet: "A second canned search result.",
    },
];
/** Test seam: replace the canned results (respects maxResults slicing). */
export function setStubResults(results) {
    canned = results;
}
export function makeStubProvider() {
    return {
        id: "stub",
        isConfigured() {
            return true;
        },
        async search(_query, opts) {
            const max = opts?.maxResults ?? 5;
            return canned.slice(0, max);
        },
    };
}
//# sourceMappingURL=stub.js.map