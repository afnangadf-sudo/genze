// Owner-only preHandler (/admin/*, GET|PATCH /moderation/reports). 401s come
// from `authenticate`; a signed-in non-owner gets 403 FORBIDDEN with a
// plain-language message. The owner flag lives on the users row
// (set at signup from OWNER_EMAIL).
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "./authenticate.js";
export async function requireOwner(req, reply) {
    await authenticate(req, reply);
    if (reply.sent)
        return;
    const userId = req.auth.userId;
    const r = await getPool().query("SELECT is_owner FROM users WHERE id = $1", [userId]);
    if (!r.rowCount || !r.rows[0].is_owner) {
        sendError(reply, 403, "FORBIDDEN", "Only the app owner can open this area.");
    }
}
//# sourceMappingURL=requireOwner.js.map