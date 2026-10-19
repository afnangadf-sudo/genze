// OpenAI chat completions streaming provider (global fetch, SSE).
// Key comes from OPENAI_API_KEY only — never logged, never returned.
import { abortError, readSseEvents } from "./sse.js";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
function providerError(status, message) {
    const err = new Error(message);
    err.statusCode = status;
    return err;
}
/**
 * One non-streaming tool-decision call (Step 6): native OpenAI function-
 * calling API. Returns the model's requested tool calls (possibly empty).
 */
export async function openaiDecideToolCalls(model, options) {
    const key = process.env.OPENAI_API_KEY;
    if (!key)
        throw providerError(503, "OpenAI is not configured.");
    if (options.signal.aborted)
        throw abortError();
    const wireMessages = [];
    if (options.system)
        wireMessages.push({ role: "system", content: options.system });
    // Decision call is text-only: vision images don't travel here.
    for (const m of options.messages)
        wireMessages.push({ role: m.role, content: m.content });
    let res;
    try {
        res = await fetch(OPENAI_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
                model,
                messages: wireMessages,
                tools: options.tools.map((t) => ({
                    type: "function",
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.inputSchema,
                    },
                })),
                tool_choice: "auto",
            }),
            signal: options.signal,
        });
    }
    catch (err) {
        if (options.signal.aborted || err?.name === "AbortError")
            throw abortError();
        throw err;
    }
    if (!res.ok) {
        let message = `OpenAI request failed (HTTP ${res.status}).`;
        try {
            const payload = (await res.json());
            if (payload?.error?.message)
                message = payload.error.message;
        }
        catch {
            // keep the generic message
        }
        throw providerError(res.status, message);
    }
    const payload = (await res.json());
    const toolCalls = [];
    for (const tc of payload.choices?.[0]?.message?.tool_calls ?? []) {
        const name = tc?.function?.name;
        if (tc?.type !== "function" || typeof name !== "string")
            continue;
        let input = {};
        try {
            const parsed = JSON.parse(tc.function?.arguments ?? "{}");
            if (parsed && typeof parsed === "object")
                input = parsed;
        }
        catch {
            // keep empty input
        }
        toolCalls.push({ name, input });
    }
    return { toolCalls };
}
export function makeOpenAIProvider(model) {
    return {
        id: "openai",
        model,
        decideToolCalls: (options) => openaiDecideToolCalls(model, options),
        async streamChat({ system, messages, signal, onToken }) {
            const key = process.env.OPENAI_API_KEY;
            if (!key) {
                const err = new Error("OpenAI is not configured.");
                err.statusCode = 503;
                throw err;
            }
            if (signal.aborted)
                throw abortError();
            const wireMessages = [];
            if (system)
                wireMessages.push({ role: "system", content: system });
            for (const m of messages) {
                wireMessages.push({
                    role: m.role,
                    content: m.images && m.images.length > 0
                        ? [
                            { type: "text", text: m.content },
                            ...m.images.map((img) => ({
                                type: "image_url",
                                image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
                            })),
                        ]
                        : m.content,
                });
            }
            let res;
            try {
                res = await fetch(OPENAI_URL, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        authorization: `Bearer ${key}`,
                    },
                    body: JSON.stringify({
                        model,
                        stream: true,
                        stream_options: { include_usage: true },
                        messages: wireMessages,
                    }),
                    signal,
                });
            }
            catch (err) {
                if (signal.aborted || err?.name === "AbortError")
                    throw abortError();
                throw err;
            }
            if (!res.ok) {
                let message = `OpenAI request failed (HTTP ${res.status}).`;
                try {
                    const payload = (await res.json());
                    if (payload?.error?.message)
                        message = payload.error.message;
                }
                catch {
                    // keep the generic message
                }
                const err = new Error(message);
                err.statusCode = res.status;
                throw err;
            }
            let inputTokens = 0;
            let outputTokens = 0;
            for await (const { data } of readSseEvents(res.body, signal)) {
                if (data === "[DONE]")
                    break;
                let chunk;
                try {
                    chunk = JSON.parse(data);
                }
                catch {
                    continue;
                }
                const text = chunk.choices?.[0]?.delta?.content;
                if (typeof text === "string" && text.length > 0)
                    onToken(text);
                if (chunk.usage?.prompt_tokens != null)
                    inputTokens = chunk.usage.prompt_tokens;
                if (chunk.usage?.completion_tokens != null)
                    outputTokens = chunk.usage.completion_tokens;
            }
            return { inputTokens, outputTokens };
        },
    };
}
//# sourceMappingURL=openai.js.map