// Guided Learning — "Teach me" tutor mode (chat polish).
//
// A per-thread toggle. When on, a tutor overlay is added to the system
// prompt (contract order: project instructions → gem → skills → tutor →
// memory) that steers the model toward guided questions, hints and small
// steps instead of direct answers. The overlay is language-agnostic: the
// preferred-language instruction is prepended separately and still applies.
//
// TUTOR_MODE_MARKER is a stable string the demo provider sniffs for so that
// keyless (demo) chat also demonstrates the tutor style instead of a direct
// canned answer. Never change the marker without updating the demo provider.

/** Stable marker identifying the tutor overlay in an assembled system prompt. */
export const TUTOR_MODE_MARKER = "[Teach-me mode]";

/**
 * The tutor overlay block. Plain language, no jargon (never say "Socratic"
 * to the model or the user — the UI calls it "Teach me").
 */
export const TUTOR_PROMPT = `${TUTOR_MODE_MARKER}
Teach-me mode is ON: the user wants to LEARN, not just get the answer.
- Do NOT give the full answer right away.
- Ask one short guiding question at a time to find out what the user already knows.
- Give small hints and break problems into tiny steps.
- Check understanding before moving on ("Does that make sense so far? Try the next step.").
- Only give the complete answer when the user is stuck, frustrated, or explicitly asks for it.
- Keep every reply short and encouraging.`;

/** The system-prompt block appended for tutor mode. Empty string when off. */
export function tutorBlock(tutorMode: boolean): string {
  return tutorMode ? TUTOR_PROMPT : "";
}
