// Region seed (from research/02, uppercase ISO codes). Fail-closed: any
// country not listed here gets NO providers. Extend this table from official
// provider lists before launch — never guess.
export const REGION_RULES = [
    { country: "PK", providers: ["anthropic", "openai", "google"] },
    { country: "AF", providers: ["openai"] },
    // Gulf states verified from official lists:
    { country: "AE", providers: ["anthropic", "openai", "google"] },
    { country: "SA", providers: ["anthropic", "openai", "google"] },
    { country: "QA", providers: ["anthropic", "openai", "google"] },
    { country: "KW", providers: ["anthropic", "openai", "google"] },
    { country: "BH", providers: ["anthropic", "openai", "google"] },
    { country: "OM", providers: ["anthropic", "openai", "google"] },
    { country: "PS", providers: ["anthropic", "openai", "google"] },
    { country: "US", providers: ["anthropic", "openai", "google"] },
    { country: "GB", providers: ["anthropic", "openai", "google"] },
];
export const REGION_MAP = new Map(REGION_RULES.map((r) => [r.country, r.providers]));
//# sourceMappingURL=regions.js.map