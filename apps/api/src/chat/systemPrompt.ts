// System-prompt prefix assembly (chat polish).
//
// Contract order for the prefix blocks, before the base prompt:
//   project instructions → gem → skills → tutor → memory.
// Compaction summaries ride on the base prompt itself (see chat/compaction.ts),
// and the preferred-language instruction is prepended last (see chat/language.ts).
// File context is appended after the base prompt (unchanged).

/** Prefix blocks in contract order; each is "" when absent. */
export interface SystemPrefixParts {
  projectInstructions?: string;
  gem?: string;
  skills?: string;
  tutor?: string;
  memory?: string;
}

/** Join the contract-ordered prefix blocks, skipping empty ones. Pure. */
export function assembleSystemPrefix(parts: SystemPrefixParts): string {
  return [
    parts.projectInstructions,
    parts.gem,
    parts.skills,
    parts.tutor,
    parts.memory,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n\n");
}
