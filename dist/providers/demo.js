// Built-in demo provider: used when NO chat-capable provider key is
// configured (ANTHROPIC_API_KEY and OPENAI_API_KEY both unset). Nothing
// leaves the server. Every reply is clearly labeled as a demo answer and
// every event / saved message carries demo:true.
//
// Chat polish: when the assembled system prompt carries TUTOR_MODE_MARKER
// (see chat/tutor.ts), the demo streams a guided tutor-style reply instead
// of the canned direct answer — so keyless users can feel "Teach me" mode.
// The reply still carries demo:true and is metered exactly like before.
import { TUTOR_MODE_MARKER } from "../chat/tutor.js";
import { abortError } from "./sse.js";
const DEMO_REPLY = "This is a demo answer from Genze. No AI provider keys are configured, so " +
    "this reply was written locally on this server and nothing was sent anywhere. " +
    "Add a provider key and grant consent to get real answers.";
/**
 * Build the guided tutor reply: a question inviting the user to think,
 * referencing what they asked about briefly — never a direct answer.
 */
function guidedReply(messages) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const topic = lastUser ? lastUser.content.trim().replace(/\s+/g, " ").slice(0, 80) : "this";
    const quoted = topic ? `"${topic}${lastUser && lastUser.content.trim().length > 80 ? "…" : ""}"` : "this";
    return (`Teach-me mode is on — let's work through it together instead of me just giving you the answer. ` +
        `You asked about ${quoted}. Before we go further, tell me: what do you already know about it? ` +
        `What's the very first small step you would try, and why? Take a guess — even a rough one — ` +
        `and I'll give you a hint for the next step.`);
}
function abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
export function makeDemoProvider() {
    return {
        id: "demo",
        model: "demo",
        async streamChat({ system, messages, signal, onToken }) {
            if (signal.aborted)
                throw abortError();
            const tutor = (system ?? "").includes(TUTOR_MODE_MARKER);
            const reply = tutor ? guidedReply(messages) : DEMO_REPLY;
            const words = reply.split(" ");
            for (let i = 0; i < words.length; i++) {
                if (signal.aborted)
                    throw abortError();
                onToken(words[i] + (i < words.length - 1 ? " " : ""));
                await abortableSleep(15, signal);
            }
            const inputChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
            return {
                inputTokens: Math.max(1, Math.ceil(inputChars / 4)),
                outputTokens: Math.ceil(reply.length / 4),
            };
        },
    };
}
//# sourceMappingURL=demo.js.map