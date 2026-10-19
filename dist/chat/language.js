// Chat language instruction (Step 4 multilingual v1, opened up 2026-10-18:
// ANY BCP-47 code is accepted, not just the five UI languages). On real
// (non-demo) chat the server prepends
//   "Reply in <Language> unless the user writes in another language."
// to the fully assembled system prompt, so the model honors the user's
// preferred_language (project instructions, memory context, compaction
// summary and file context are all system-prompt parts and compose with it).
// Demo chat is untouched: nothing leaves the server and the demo reply is
// fixed local copy anyway.
import { languageDisplayName } from "@genze/shared";
/** The exact instruction prepended to the chat system prompt. */
export function languageInstruction(language) {
    return `Reply in ${languageDisplayName(language)} unless the user writes in another language.`;
}
/**
 * Prepends the language instruction to the assembled system prompt.
 * Demo chat is returned untouched.
 */
export function applyLanguageInstruction(system, opts) {
    if (opts.demo)
        return system;
    return `${languageInstruction(opts.language)}\n\n${system}`;
}
//# sourceMappingURL=language.js.map