// Consent UI copy: display names + plain-language "what sees" sentences.
// This is the only place these strings live; the web app renders them as-is.
//
// Step 9: providers gain per-capability lines (image/video/voice) describing
// what Studio sends them. Consent itself stays per provider (one
// consent_records row): granting a provider covers chat and Studio alike,
// and each surface shows the copy for the data it actually sends.
const NEVER = "never receives your name, email, or password.";
export const CONSENT_COPY = {
    anthropic: {
        name: "Anthropic",
        whatSees: "Your chat messages are sent to Anthropic so its Claude model can write a reply. " +
            `Anthropic ${NEVER}`,
    },
    openai: {
        name: "OpenAI",
        whatSees: "Your chat messages are sent to OpenAI so its model can write a reply. " +
            `OpenAI ${NEVER}`,
        image: "Your image descriptions are sent to OpenAI so it can create pictures for you. " +
            `OpenAI ${NEVER}`,
        voice: "Your text and voice recordings are sent to OpenAI so it can turn speech into text or text into speech. " +
            `OpenAI ${NEVER}`,
    },
    google: {
        name: "Google",
        whatSees: "Your chat messages are sent to Google so its Gemini model can write a reply. " +
            `Google ${NEVER}`,
        image: "Your image descriptions are sent to Google so it can create pictures for you. " +
            `Google ${NEVER}`,
        video: "Your video descriptions are sent to Google so it can create short video clips for you. " +
            `Google ${NEVER}`,
        voice: "Your text and voice recordings are sent to Google so it can turn speech into text or text into speech. " +
            `Google ${NEVER}`,
    },
    kling: {
        name: "Kling",
        whatSees: "Your video descriptions are sent to Kling so it can create short video clips for you. " +
            `Kling ${NEVER}`,
        video: "Your video descriptions are sent to Kling so it can create short video clips for you. " +
            `Kling ${NEVER}`,
    },
    steel: {
        name: "Steel",
        whatSees: "Steel powers the cloud browser. It never receives your name, email, or password.",
    },
    elevenlabs: {
        name: "ElevenLabs",
        whatSees: "Your text is sent to ElevenLabs so it can speak it aloud. " + `ElevenLabs ${NEVER}`,
        voice: "Your text is sent to ElevenLabs so it can speak it aloud. " + `ElevenLabs ${NEVER}`,
    },
    // Keyless free AI (used automatically when no provider key is configured).
    // Honest copy: messages go to a free community AI service.
    free: {
        name: "Free AI",
        whatSees: "Your chat messages are sent to a free community AI service so it can write a reply. " +
            "It never receives your name, email, or password.",
    },
};
/** Studio capabilities each provider actually implements (subset of the
 *  registry capability map, kept here so the consent surface stays honest). */
export const STUDIO_CAPABILITIES = {
    anthropic: [],
    openai: ["image", "voice"],
    google: ["image", "video", "voice"],
    kling: ["video"],
    steel: [],
    elevenlabs: ["voice"],
};
/** The plain-language Studio sentence(s) for a provider: its image/video/voice
 *  lines joined, falling back to the chat line when a capability has no
 *  dedicated copy. */
export function studioConsentCopy(id) {
    const copy = CONSENT_COPY[id];
    const lines = STUDIO_CAPABILITIES[id]
        .map((c) => copy[c])
        .filter((s) => typeof s === "string" && s.length > 0);
    return lines.length > 0 ? lines.join(" ") : copy.whatSees;
}
//# sourceMappingURL=consentCopy.js.map