// Bearer-token authentication preHandler.
//
// The access JWT is stateless but carries a `sid` (session id) claim; we check
// the session row on every request so logout / logout-all / password-reset
// take effect immediately instead of lingering for the token's 15 minutes.
// Also bumps sessions.last_active_at so the device list stays fresh.
import { getPool } from "../db.js";
import { loadConfig } from "../config.js";
import { verifyAccessToken } from "../crypto.js";
import { sendError } from "../errors.js";
export async function authenticate(req, reply) {
    const header = req.headers.authorization;
    const token = header && header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) {
        sendError(reply, 401, "UNAUTHORIZED", "Authentication required.");
        return;
    }
    const claims = verifyAccessToken(token, loadConfig().jwtAccessSecret);
    if (!claims) {
        sendError(reply, 401, "UNAUTHORIZED", "Invalid or expired access token.");
        return;
    }
    const pool = getPool();
    const session = await pool.query("SELECT id FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [
        claims.sid,
        claims.sub,
    ]);
    if (!session.rowCount) {
        sendError(reply, 401, "UNAUTHORIZED", "This session has been revoked. Please log in again.");
        return;
    }
    const banned = await pool.query("SELECT banned_at FROM users WHERE id = $1", [claims.sub]);
    if (banned.rowCount && banned.rows[0].banned_at !== null) {
        sendError(reply, 403, "ACCOUNT_SUSPENDED", "This account has been suspended for abuse.");
        return;
    }
    req.auth = { userId: claims.sub, sessionId: claims.sid };
    await pool.query("UPDATE sessions SET last_active_at = now() WHERE id = $1", [claims.sid]);
}
//# sourceMappingURL=authenticate.js.map