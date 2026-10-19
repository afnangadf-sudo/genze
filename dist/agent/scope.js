// Folder scope guard for the agent (Step 7b — backend-extra worker).
//
// The agent core's runner will call these before a task touches files:
// `checkFolderScope` rejects cross-folder access synchronously, and
// `scopeDiffSummary` reports what a task changed inside its folder.
//
// Defined seam (documented in CONTRACTS.md): the core runner (sibling
// worker) integrates these; these tests prove the guard behavior itself.
import { SCOPE_VIOLATION } from "@genze/shared";
import { getPool } from "../db.js";
/**
 * Enforce folder scoping: when the task is scoped to a project folder,
 * only files in that same folder are allowed. A null task scope means the
 * task may touch any folder (e.g. no project selected).
 *
 * Throws { code: SCOPE_VIOLATION } on a mismatch.
 */
export function checkFolderScope(taskProjectId, fileProjectId) {
    if (taskProjectId !== null && fileProjectId !== taskProjectId) {
        // eslint-disable-next-line no-throw-literal
        throw { code: SCOPE_VIOLATION };
    }
}
/**
 * Summarize file activity inside a project folder since a timestamp.
 * The `files` table has no `updated_at` column (migration 005), so in v1
 * the `updated` list is always empty — documented honestly here and in
 * CONTRACTS.md. `_taskId` is accepted for the core runner's call shape
 * and reserved for future per-task attribution.
 */
export async function scopeDiffSummary(_taskId, projectId, since) {
    const r = await getPool().query(`SELECT original_name FROM files
     WHERE project_id = $1 AND created_at >= $2::timestamptz
     ORDER BY created_at ASC`, [projectId, since.toISOString()]);
    return {
        created: r.rows.map((row) => row.original_name),
        updated: [],
    };
}
//# sourceMappingURL=scope.js.map