// Multi-file context assembly for chat: gathers extracted text from attached
// files and project files, labels each file clearly, and enforces a character
// budget (largest files dropped first). Images attached explicitly are also
// returned as vision inputs (base64) for the chat providers.
import { getPool } from "../db.js";
import { getStorage } from "../storage/index.js";
export function fileContextBudgetChars() {
    const raw = Number(process.env.FILE_CONTEXT_CHARS);
    if (Number.isInteger(raw) && raw > 0)
        return raw;
    return 60_000;
}
/** Images larger than this are skipped as vision input (provider limits). */
export const MAX_VISION_BYTES = 5 * 1024 * 1024;
/** Max images per request sent as vision input. */
export const MAX_VISION_IMAGES = 10;
/**
 * Assemble file context for a chat reply.
 * - `explicitFileIds`: files attached to this message (text + vision).
 * - `projectId`: the thread's project — its files contribute text only.
 * - `gemId`: the thread's gem — its attached files contribute text only,
 *   labeled `[Gem file: <name>]`, within the same char budget. Built-in gems
 *   have no files. (Chat polish.)
 */
export async function buildFileContext(userId, opts) {
    const pool = getPool();
    const ids = [...new Set(opts.explicitFileIds)];
    const rows = [];
    /** Files contributed by the thread's gem (labeled differently). */
    const gemFileIds = new Set();
    if (ids.length > 0) {
        const r = await pool.query(`SELECT id, original_name, mime_type, size_bytes, storage_key, extracted_text
       FROM files WHERE user_id = $1 AND id = ANY($2) AND status = 'ready'`, [userId, ids]);
        rows.push(...r.rows);
    }
    if (opts.projectId) {
        const r = await pool.query(`SELECT id, original_name, mime_type, size_bytes, storage_key, extracted_text
       FROM files WHERE user_id = $1 AND project_id = $2 AND status = 'ready'`, [userId, opts.projectId]);
        for (const row of r.rows) {
            if (!rows.some((x) => x.id === row.id))
                rows.push(row);
        }
    }
    if (opts.gemId) {
        // The gem is the user's own or a built-in (visibility checked at thread
        // creation); its attached files are the gem owner's files.
        const r = await pool.query(`SELECT f.id, f.original_name, f.mime_type, f.size_bytes, f.storage_key, f.extracted_text
       FROM gem_files gf
       JOIN files f ON f.id = gf.file_id
       WHERE gf.gem_id = $1 AND f.status = 'ready'`, [opts.gemId]);
        for (const row of r.rows) {
            if (!rows.some((x) => x.id === row.id)) {
                rows.push(row);
                gemFileIds.add(row.id);
            }
        }
    }
    const explicitIds = new Set(ids);
    const budget = fileContextBudgetChars();
    // Text blocks: largest first, drop until within budget. A single file
    // larger than the whole budget is truncated to fit (marked as such).
    const withText = rows.filter((r) => r.extracted_text && r.extracted_text.length > 0);
    withText.sort((a, b) => b.extracted_text.length - a.extracted_text.length);
    const kept = [];
    let chars = 0;
    for (const row of withText) {
        const full = row.extracted_text;
        if (chars + full.length <= budget) {
            kept.push({ row, text: full });
            chars += full.length;
        }
    }
    if (kept.length === 0 && withText.length > 0) {
        const row = withText[0];
        const text = `${row.extracted_text.slice(0, budget)}\n[…truncated to fit the context budget]`;
        kept.push({ row, text });
        chars = budget;
    }
    const text = kept.length === 0
        ? ""
        : kept
            .map(({ row, text: t }) => `[${gemFileIds.has(row.id) ? "Gem file" : "File"}: ${row.original_name}]\n${t}`)
            .join("\n\n---\n\n");
    // Vision: explicitly attached images only, small enough, capped in count.
    const images = [];
    const storage = getStorage();
    for (const row of rows) {
        if (!explicitIds.has(row.id))
            continue;
        if (!row.mime_type.startsWith("image/"))
            continue;
        if (Number(row.size_bytes) > MAX_VISION_BYTES)
            continue;
        if (images.length >= MAX_VISION_IMAGES)
            break;
        try {
            const bytes = await storage.get(row.storage_key);
            images.push({ mimeType: row.mime_type, base64: bytes.toString("base64") });
        }
        catch {
            // unreadable image: skip it, the text path already ran
        }
    }
    return {
        text,
        images,
        stats: {
            attached: rows.length,
            included: kept.length,
            dropped: withText.length - kept.length,
            chars,
        },
    };
}
//# sourceMappingURL=context.js.map