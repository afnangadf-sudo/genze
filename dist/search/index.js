// pickSearchProvider(): the single selection point for web search.
//
// SEARCH_PROVIDER (tavily|brave|serper|stub, default tavily) names the
// provider; null when its key is missing — the routes map that to
// 503 SEARCH_NOT_CONFIGURED (never a fake result). `stub` is honored only
// when NODE_ENV=test.
import { makeTavilyProvider } from "./tavily.js";
import { makeBraveProvider } from "./brave.js";
import { makeSerperProvider } from "./serper.js";
import { makeStubProvider } from "./stub.js";
const PROVIDER_IDS = ["tavily", "brave", "serper", "stub"];
function make(id) {
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
export function pickSearchProvider() {
    const raw = (process.env.SEARCH_PROVIDER ?? "tavily").trim().toLowerCase();
    const id = PROVIDER_IDS.includes(raw)
        ? raw
        : "tavily";
    if (id === "stub" && process.env.NODE_ENV !== "test")
        return null;
    const provider = make(id);
    return provider.isConfigured() ? provider : null;
}
//# sourceMappingURL=index.js.map