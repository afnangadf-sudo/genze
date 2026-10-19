// Minimal SSE (text/event-stream) frame reader shared by the streaming chat
// providers. Yields {event, data} pairs. Heartbeat/comment lines (": ...")
// are skipped. Aborting the signal throws an AbortError.
export function abortError() {
    const err = new Error("The request was aborted.");
    err.name = "AbortError";
    return err;
}
export async function* readSseEvents(body, signal) {
    if (!body)
        return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let event = "message";
    let dataLines = [];
    function* dispatch() {
        if (dataLines.length === 0) {
            event = "message";
            return;
        }
        const ev = { event, data: dataLines.join("\n") };
        event = "message";
        dataLines = [];
        yield ev;
    }
    function* consumeBlock(block) {
        for (const rawLine of block.split("\n")) {
            const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith(":"))
                continue; // comment / heartbeat
            if (line.startsWith("event:")) {
                event = line.slice(6).trim();
            }
            else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).replace(/^ /, ""));
            }
        }
        yield* dispatch();
    }
    try {
        for (;;) {
            if (signal.aborted)
                throw abortError();
            let read;
            try {
                read = await reader.read();
            }
            catch (err) {
                if (signal.aborted || err?.name === "AbortError")
                    throw abortError();
                throw err;
            }
            if (read.value)
                buf += decoder.decode(read.value, { stream: true });
            if (read.done) {
                buf += decoder.decode();
                if (buf.length > 0)
                    yield* consumeBlock(buf);
                break;
            }
            let idx;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
                const block = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                yield* consumeBlock(block);
            }
        }
    }
    finally {
        try {
            reader.releaseLock();
        }
        catch {
            // already released / closed — nothing to do
        }
    }
}
//# sourceMappingURL=sse.js.map