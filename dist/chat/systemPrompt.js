// System-prompt prefix assembly (chat polish).
//
// Contract order for the prefix blocks, before the base prompt:
//   project instructions → gem → skills → tutor → memory.
// Compaction summaries ride on the base prompt itself (see chat/compaction.ts),
// and the preferred-language instruction is prepended last (see chat/language.ts).
// File context is appended after the base prompt (unchanged).
/** Join the contract-ordered prefix blocks, skipping empty ones. Pure. */
export function assembleSystemPrefix(parts) {
    return [
        parts.projectInstructions,
        parts.gem,
        parts.skills,
        parts.tutor,
        parts.memory,
    ]
        .filter((s) => typeof s === "string" && s.length > 0)
        .join("\n\n");
}
//# sourceMappingURL=systemPrompt.js.map