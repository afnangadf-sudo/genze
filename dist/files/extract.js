// Text extraction for uploaded files. Runs inline at upload time (fast for
// documents/spreadsheets/images); audio transcription calls OpenAI only when
// OPENAI_API_KEY is set, otherwise the file is stored and marked
// "not_configured". Extraction never throws — failures mark the file failed.
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { imageSize } from "image-size";
/** Extracted text is capped so one giant file can't blow up the database. */
export const MAX_EXTRACT_CHARS = 200_000;
const MIME_KIND = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "text/csv": "csv",
    "application/csv": "csv",
    "image/png": "image",
    "image/jpeg": "image",
    "image/webp": "image",
    "audio/mpeg": "audio",
    "audio/wav": "audio",
    "audio/x-wav": "audio",
    "audio/mp4": "audio",
    "audio/x-m4a": "audio",
};
export function kindForMime(mime) {
    return MIME_KIND[mime.toLowerCase()] ?? null;
}
function truncate(text) {
    return text.length > MAX_EXTRACT_CHARS ? text.slice(0, MAX_EXTRACT_CHARS) : text;
}
async function extractPdf(data) {
    const parser = new PDFParse({ data });
    try {
        const result = (await parser.getText());
        return typeof result?.text === "string" ? result.text : "";
    }
    finally {
        await parser.destroy().catch(() => undefined);
    }
}
/** Extract text from a PDF buffer. Shared with the Step 4 research fetcher. */
export async function extractPdfText(data) {
    return truncate(await extractPdf(data));
}
async function extractDocx(data) {
    const result = await mammoth.extractRawText({ buffer: data });
    return result.value ?? "";
}
function sheetToMarkdown(name, rows) {
    const head = `## Sheet: ${name}`;
    if (rows.length === 0)
        return `${head}\n(empty)`;
    const capped = rows.slice(0, 200).map((r) => r.slice(0, 50).map((c) => String(c ?? "")));
    const widths = capped[0].map((_, i) => Math.max(...capped.map((r) => (r[i] ?? "").length), 3));
    const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
    const out = [head, line(capped[0]), `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`];
    for (let i = 1; i < capped.length; i++)
        out.push(line(capped[i]));
    return out.join("\n");
}
function extractSpreadsheet(data) {
    const wb = XLSX.read(data, { type: "buffer" });
    const parts = [];
    for (const name of wb.SheetNames.slice(0, 10)) {
        const ws = wb.Sheets[name];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        parts.push(sheetToMarkdown(name, rows));
    }
    return parts.join("\n\n");
}
async function transcribeAudio(data, mime, filename) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
        const err = new Error("not_configured");
        err.code = "NOT_CONFIGURED";
        throw err;
    }
    const form = new FormData();
    form.append("model", "gpt-4o-mini-transcribe");
    form.append("file", new Blob([new Uint8Array(data)], { type: mime }), filename);
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: form,
    });
    if (!res.ok) {
        throw new Error(`Transcription failed (HTTP ${res.status}).`);
    }
    const payload = (await res.json());
    return typeof payload.text === "string" ? payload.text : "";
}
export async function extractFile(kind, mime, filename, data) {
    const empty = {
        text: null,
        transcriptStatus: null,
        imageWidth: null,
        imageHeight: null,
    };
    try {
        switch (kind) {
            case "pdf":
                return { ...empty, text: truncate(await extractPdf(data)) };
            case "docx":
                return { ...empty, text: truncate(await extractDocx(data)) };
            case "xlsx":
            case "csv":
                return { ...empty, text: truncate(extractSpreadsheet(data)) };
            case "image": {
                const dims = imageSize(data);
                return {
                    ...empty,
                    imageWidth: typeof dims.width === "number" ? dims.width : null,
                    imageHeight: typeof dims.height === "number" ? dims.height : null,
                };
            }
            case "audio": {
                const text = truncate(await transcribeAudio(data, mime, filename));
                return { ...empty, text, transcriptStatus: "ready" };
            }
        }
    }
    catch (err) {
        if (err.code === "NOT_CONFIGURED") {
            return { ...empty, transcriptStatus: "not_configured" };
        }
        if (kind === "audio")
            return { ...empty, transcriptStatus: "failed" };
        // Documents/spreadsheets/images: mark failed, keep the stored file.
        throw err;
    }
    return empty;
}
//# sourceMappingURL=extract.js.map