// Ownership-checked cascade deletes shared by the files, projects, chat and
// library routes. Storage objects are removed alongside DB rows.
import { getPool } from "../db.js";
import { getStorage } from "../storage/index.js";
/** Delete one file: storage object + row. Returns false when not found/owned. */
export async function deleteFileCascade(userId, fileId) {
    const pool = getPool();
    const r = await pool.query("SELECT storage_key FROM files WHERE id = $1 AND user_id = $2", [fileId, userId]);
    if (!r.rowCount)
        return false;
    await getStorage().delete(r.rows[0].storage_key);
    await pool.query("DELETE FROM files WHERE id = $1", [fileId]);
    return true;
}
/** Delete a project: its files' storage objects, then the row (file rows and
 *  message links cascade via FK; chat threads keep their messages but lose
 *  the project link via ON DELETE SET NULL). */
export async function deleteProjectCascade(userId, projectId) {
    const pool = getPool();
    const r = await pool.query(`SELECT f.storage_key FROM files f
     JOIN projects p ON p.id = f.project_id
     WHERE p.id = $1 AND p.user_id = $2`, [projectId, userId]);
    if (!r.rowCount) {
        const own = await pool.query("SELECT 1 FROM projects WHERE id = $1 AND user_id = $2", [
            projectId,
            userId,
        ]);
        if (!own.rowCount)
            return false;
    }
    const storage = getStorage();
    for (const row of r.rows) {
        await storage.delete(row.storage_key);
    }
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
    return true;
}
/** Delete a chat thread (messages cascade via FK; files are independent). */
export async function deleteThreadCascade(userId, threadId) {
    const r = await getPool().query("DELETE FROM chat_threads WHERE id = $1 AND user_id = $2 RETURNING id", [threadId, userId]);
    return (r.rowCount ?? 0) > 0;
}
//# sourceMappingURL=cascade.js.map