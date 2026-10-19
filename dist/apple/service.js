// Sign in with Apple: token verification entry point + find-or-create.
//
// `appleHooks.verify` is the test seam: the default implementation verifies
// against Apple's real JWKS; tests override it so the suite never touches
// appleid.apple.com (the pure verifier in ./verify.ts is unit-tested with a
// locally generated keypair instead).
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { loadConfig } from "../config.js";
import { fetchAppleJwks } from "./jwks.js";
import { verifyAppleIdentityToken } from "./verify.js";
export const appleHooks = {
    verify: async (identityToken, nonce) => {
        const clientId = loadConfig().appleClientId;
        if (!clientId)
            throw new Error("APPLE_CLIENT_ID is not set");
        const jwks = await fetchAppleJwks();
        return verifyAppleIdentityToken(identityToken, { clientId, nonce, jwks });
    },
};
/**
 * Find-or-create by `users.apple_sub`. If no row has this Apple sub but a
 * row exists with the same (Apple-verified) email, the Apple identity is
 * linked onto that account — same linking rule as the Google OAuth flow, so
 * one person never ends up with two accounts. Otherwise a fresh user is
 * created: email already verified by Apple (private-relay addresses are
 * accepted as-is), and country defaults to "US" because the Apple token
 * carries no country.
 */
export async function findOrCreateAppleUser(sub, email) {
    const pool = getPool();
    const bySub = await pool.query("SELECT id FROM users WHERE apple_sub = $1", [sub]);
    if (bySub.rowCount)
        return { userId: bySub.rows[0].id, isNew: false };
    const byEmail = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (byEmail.rowCount) {
        await pool.query("UPDATE users SET apple_sub = $1, email_verified = true, updated_at = now() WHERE id = $2", [sub, byEmail.rows[0].id]);
        return { userId: byEmail.rows[0].id, isNew: false };
    }
    const id = uuidv4();
    await pool.query("INSERT INTO users (id, email, password_hash, email_verified, country, apple_sub) VALUES ($1, $2, NULL, true, 'US', $3)", [id, email, sub]);
    return { userId: id, isNew: true };
}
//# sourceMappingURL=service.js.map