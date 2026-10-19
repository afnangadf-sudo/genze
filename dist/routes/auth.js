// Auth routes (prefix /api/v1/auth). All response shapes follow CONTRACTS.md:
// success -> { data: ... }, errors -> { error: { code, message } }.
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { loadConfig } from "../config.js";
import { sendError } from "../errors.js";
import { isValidEmail, isValidPassword, normalizeCountry } from "../validation.js";
import { REFRESH_TOKEN_MAX_AGE_MS, dummyPasswordCompare, hashPassword, newEmailToken, newRefreshToken, sha256Hex, signAccessToken, verifyPassword, } from "../crypto.js";
import { authenticator } from "../totp.js";
import { sendAuthEmail } from "../email.js";
import { authenticate } from "../middleware/authenticate.js";
import { isSupportedLanguage } from "../users.js";
import { appleHooks, findOrCreateAppleUser } from "../apple/service.js";
import { AppleTokenError } from "../apple/verify.js";
// Per CONTRACTS.md: 10 req / 15 min per IP on signup/login/forgot/reset,
// 20 / 15 min on verify-email. (login/2fa shares login's budget.)
const STRICT_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: "15 minutes" } };
const VERIFY_RATE_LIMIT = { rateLimit: { max: 20, timeWindow: "15 minutes" } };
function toPublicUser(row) {
    return {
        id: row.id,
        email: row.email,
        emailVerified: row.email_verified,
        country: row.country,
        totpEnabled: row.totp_enabled,
        preferredLanguage: row.preferred_language,
        plan: row.plan === "paid" ? "paid" : "free",
        isOwner: row.is_owner === true,
        aiNoticeAccepted: row.ai_notice_accepted_at != null,
        createdAt: new Date(row.created_at).toISOString(),
    };
}
async function getUserById(userId) {
    const r = await getPool().query("SELECT * FROM users WHERE id = $1", [userId]);
    return r.rowCount ? r.rows[0] : null;
}
function bodyOf(req) {
    return req.body ?? {};
}
function deviceName(req) {
    const ua = req.headers["user-agent"];
    if (!ua)
        return "Unknown device";
    return ua.length > 200 ? ua.slice(0, 200) : ua;
}
/** Creates a session row + token pair (the login/refresh/2fa success path). */
async function createSession(userId, req) {
    const config = loadConfig();
    const refreshToken = newRefreshToken();
    const sessionId = uuidv4();
    await getPool().query(`INSERT INTO sessions (id, user_id, refresh_token_hash, device_name, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`, [
        sessionId,
        userId,
        sha256Hex(refreshToken),
        deviceName(req),
        req.ip ?? null,
        (req.headers["user-agent"] ?? "").slice(0, 500),
    ]);
    return {
        accessToken: signAccessToken(userId, sessionId, config.jwtAccessSecret),
        refreshToken,
        sessionId,
    };
}
// ---------------------------------------------------------------------------
// POST /signup { email, password, country } -> 201 { data: { user } }
// ---------------------------------------------------------------------------
async function signup(req, reply) {
    const body = bodyOf(req);
    const rawEmail = body.email;
    const password = body.password;
    const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
    if (!isValidEmail(email)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Enter a valid email address.");
    }
    if (!isValidPassword(password)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Password must be 8–72 characters long.");
    }
    const country = normalizeCountry(body.country);
    if (!country) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Country must be a 2-letter ISO code (e.g. PK).");
    }
    // Step 4 multilingual v1, opened up 2026-10-18: optional signup language,
    // any BCP-47 code as free text, default 'en'.
    const language = body.language === undefined ? "en" : body.language;
    if (!isSupportedLanguage(language)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Unknown language.");
    }
    const pool = getPool();
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rowCount) {
        return sendError(reply, 400, "VALIDATION_ERROR", "An account with this email already exists.");
    }
    const userId = uuidv4();
    try {
        await pool.query("INSERT INTO users (id, email, password_hash, country, preferred_language) VALUES ($1, $2, $3, $4, $5)", [userId, email, await hashPassword(password), country, language.toLowerCase()]);
    }
    catch (err) {
        // Race with a concurrent signup for the same email.
        if (err && typeof err === "object" && err.code === "23505") {
            return sendError(reply, 400, "VALIDATION_ERROR", "An account with this email already exists.");
        }
        throw err;
    }
    const token = newEmailToken();
    await pool.query("INSERT INTO email_tokens (id, user_id, type, token_hash, expires_at) VALUES ($1, $2, 'verify', $3, now() + interval '24 hours')", [uuidv4(), userId, sha256Hex(token)]);
    await sendAuthEmail("verify", email, token);
    const user = await getUserById(userId);
    return reply.code(201).send({ data: { user: toPublicUser(user) } });
}
// ---------------------------------------------------------------------------
// POST /verify-email { token } -> 200 { data: { user } }
// ---------------------------------------------------------------------------
async function verifyEmail(req, reply) {
    const { token } = bodyOf(req);
    if (typeof token !== "string" || !token) {
        return sendError(reply, 400, "VALIDATION_ERROR", "A verification token is required.");
    }
    const pool = getPool();
    const r = await pool.query("SELECT id, user_id, used_at, expires_at FROM email_tokens WHERE token_hash = $1 AND type = 'verify'", [sha256Hex(token)]);
    if (!r.rowCount)
        return sendError(reply, 400, "TOKEN_INVALID", "This verification link is invalid.");
    const t = r.rows[0];
    if (t.used_at)
        return sendError(reply, 400, "TOKEN_INVALID", "This verification link has already been used.");
    if (new Date(t.expires_at).getTime() < Date.now()) {
        return sendError(reply, 400, "TOKEN_EXPIRED", "This verification link has expired. Sign up again to get a new one.");
    }
    await pool.query("UPDATE email_tokens SET used_at = now() WHERE id = $1", [t.id]);
    await pool.query("UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1", [t.user_id]);
    const user = await getUserById(t.user_id);
    return reply.send({ data: { user: toPublicUser(user) } });
}
// ---------------------------------------------------------------------------
// POST /login { email, password } -> 200 | 202 (2FA) | 401 | 403
// ---------------------------------------------------------------------------
async function login(req, reply) {
    const body = bodyOf(req);
    const rawEmail = body.email;
    const password = body.password;
    const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
    if (!email || typeof password !== "string" || !password) {
        return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid email or password.");
    }
    const pool = getPool();
    const r = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = (r.rowCount ? r.rows[0] : null);
    let passwordOk = false;
    if (user?.password_hash) {
        passwordOk = await verifyPassword(password, user.password_hash);
    }
    else {
        await dummyPasswordCompare(password); // timing noise; result discarded
    }
    if (!user || !passwordOk) {
        return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid email or password.");
    }
    if (!user.email_verified) {
        return sendError(reply, 403, "EMAIL_NOT_VERIFIED", "Please verify your email address before logging in.");
    }
    if (user.banned_at !== null && user.banned_at !== undefined) {
        return sendError(reply, 403, "ACCOUNT_SUSPENDED", "This account has been suspended for abuse.");
    }
    if (user.totp_enabled) {
        const pendingToken = newEmailToken();
        await pool.query("INSERT INTO email_tokens (id, user_id, type, token_hash, expires_at) VALUES ($1, $2, '2fa_pending', $3, now() + interval '10 minutes')", [uuidv4(), user.id, sha256Hex(pendingToken)]);
        return reply.code(202).send({ data: { twoFactorRequired: true, pendingToken } });
    }
    const { accessToken, refreshToken } = await createSession(user.id, req);
    return reply.send({ data: { tokens: { accessToken, refreshToken }, user: toPublicUser(user) } });
}
// ---------------------------------------------------------------------------
// POST /login/2fa { pendingToken, code } -> 200 tokens+user
// ---------------------------------------------------------------------------
async function login2fa(req, reply) {
    const { pendingToken, code } = bodyOf(req);
    if (typeof pendingToken !== "string" || !pendingToken) {
        return sendError(reply, 400, "VALIDATION_ERROR", "A pending token is required.");
    }
    const pool = getPool();
    const r = await pool.query("SELECT id, user_id, used_at, expires_at FROM email_tokens WHERE token_hash = $1 AND type = '2fa_pending'", [sha256Hex(pendingToken)]);
    if (!r.rowCount)
        return sendError(reply, 400, "TOKEN_INVALID", "This two-factor session is invalid.");
    const t = r.rows[0];
    if (t.used_at)
        return sendError(reply, 400, "TOKEN_INVALID", "This two-factor session has already been used.");
    if (new Date(t.expires_at).getTime() < Date.now()) {
        return sendError(reply, 400, "TOKEN_EXPIRED", "This two-factor session has expired. Log in again.");
    }
    const user = await getUserById(t.user_id);
    if (!user || !user.totp_enabled || !user.totp_secret) {
        return sendError(reply, 401, "INVALID_CREDENTIALS", "Two-factor authentication is not enabled for this account.");
    }
    if (typeof code !== "string" || !authenticator.check(code.trim(), user.totp_secret)) {
        return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid two-factor code.");
    }
    await pool.query("UPDATE email_tokens SET used_at = now() WHERE id = $1", [t.id]);
    const { accessToken, refreshToken } = await createSession(user.id, req);
    return reply.send({ data: { tokens: { accessToken, refreshToken }, user: toPublicUser(user) } });
}
// ---------------------------------------------------------------------------
// POST /refresh { refreshToken } -> 200 rotated pair (old token revoked)
// ---------------------------------------------------------------------------
async function refresh(req, reply) {
    const { refreshToken } = bodyOf(req);
    if (typeof refreshToken !== "string" || !refreshToken) {
        return sendError(reply, 401, "UNAUTHORIZED", "A refresh token is required.");
    }
    const pool = getPool();
    const r = await pool.query("SELECT id, user_id, created_at, revoked_at FROM sessions WHERE refresh_token_hash = $1", [
        sha256Hex(refreshToken),
    ]);
    const session = r.rowCount ? r.rows[0] : null;
    if (!session ||
        session.revoked_at ||
        Date.now() - new Date(session.created_at).getTime() > REFRESH_TOKEN_MAX_AGE_MS) {
        return sendError(reply, 401, "UNAUTHORIZED", "Invalid or expired refresh token.");
    }
    // Atomic single-use: the WHERE revoked_at IS NULL makes a concurrent double
    // rotation fail — only the first request wins.
    const revoked = await pool.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [
        session.id,
    ]);
    if (!revoked.rowCount) {
        return sendError(reply, 401, "UNAUTHORIZED", "Invalid or expired refresh token.");
    }
    const user = await getUserById(session.user_id);
    if (!user)
        return sendError(reply, 401, "UNAUTHORIZED", "Account no longer exists.");
    const { accessToken, refreshToken: next } = await createSession(user.id, req);
    return reply.send({ data: { tokens: { accessToken, refreshToken: next }, user: toPublicUser(user) } });
}
// ---------------------------------------------------------------------------
// POST /logout (auth) { refreshToken? } — with a token revokes that session,
// without a body revokes the current session (via the sid claim).
// POST /logout-all (auth) — revokes every session of the user.
// ---------------------------------------------------------------------------
async function logout(req, reply) {
    const auth = req.auth;
    const { refreshToken } = bodyOf(req);
    const pool = getPool();
    if (typeof refreshToken === "string" && refreshToken) {
        await pool.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND refresh_token_hash = $2 AND revoked_at IS NULL", [auth.userId, sha256Hex(refreshToken)]);
    }
    else {
        await pool.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2", [
            auth.sessionId,
            auth.userId,
        ]);
    }
    return reply.send({ data: { ok: true } });
}
async function logoutAll(req, reply) {
    const auth = req.auth;
    await getPool().query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [
        auth.userId,
    ]);
    return reply.send({ data: { ok: true } });
}
// ---------------------------------------------------------------------------
// POST /forgot-password { email } -> always 200 (no user enumeration)
// POST /reset-password { token, newPassword } -> 200, revokes all sessions
// ---------------------------------------------------------------------------
async function forgotPassword(req, reply) {
    const { email } = bodyOf(req);
    if (typeof email === "string" && isValidEmail(email)) {
        const normalized = email.trim().toLowerCase();
        const r = await getPool().query("SELECT id FROM users WHERE email = $1", [normalized]);
        if (r.rowCount) {
            const token = newEmailToken();
            await getPool().query("INSERT INTO email_tokens (id, user_id, type, token_hash, expires_at) VALUES ($1, $2, 'reset', $3, now() + interval '1 hour')", [uuidv4(), r.rows[0].id, sha256Hex(token)]);
            await sendAuthEmail("reset", normalized, token);
        }
    }
    return reply.send({ data: { ok: true } });
}
async function resetPassword(req, reply) {
    const { token, newPassword } = bodyOf(req);
    if (!isValidPassword(newPassword)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Password must be 8–72 characters long.");
    }
    if (typeof token !== "string" || !token) {
        return sendError(reply, 400, "VALIDATION_ERROR", "A reset token is required.");
    }
    const pool = getPool();
    const r = await pool.query("SELECT id, user_id, used_at, expires_at FROM email_tokens WHERE token_hash = $1 AND type = 'reset'", [sha256Hex(token)]);
    if (!r.rowCount)
        return sendError(reply, 400, "TOKEN_INVALID", "This reset link is invalid.");
    const t = r.rows[0];
    if (t.used_at)
        return sendError(reply, 400, "TOKEN_INVALID", "This reset link has already been used.");
    if (new Date(t.expires_at).getTime() < Date.now()) {
        return sendError(reply, 400, "TOKEN_EXPIRED", "This reset link has expired. Request a new one.");
    }
    await pool.query("UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2", [
        await hashPassword(newPassword),
        t.user_id,
    ]);
    await pool.query("UPDATE email_tokens SET used_at = now() WHERE id = $1", [t.id]);
    // A password reset kicks every device out.
    await pool.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [t.user_id]);
    return reply.send({ data: { ok: true } });
}
// ---------------------------------------------------------------------------
// GET /auth/devices (auth) -> { data: { devices } }, current flag via sid
// ---------------------------------------------------------------------------
async function devices(req, reply) {
    const auth = req.auth;
    const r = await getPool().query(`SELECT id, device_name, ip, created_at, last_active_at FROM sessions
     WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_active_at DESC`, [auth.userId]);
    const devices = r.rows.map((s) => ({
        id: s.id,
        deviceName: s.device_name ?? "Unknown device",
        ip: s.ip ?? null,
        lastActiveAt: new Date(s.last_active_at).toISOString(),
        createdAt: new Date(s.created_at).toISOString(),
        current: s.id === auth.sessionId,
    }));
    return reply.send({ data: { devices } });
}
// ---------------------------------------------------------------------------
// 2FA: POST /2fa/setup (auth) -> { otpauthUrl, secret }
//      POST /2fa/enable { code } -> verify & enable
//      POST /2fa/disable { code } -> verify & disable
// ---------------------------------------------------------------------------
async function twoFaSetup(req, reply) {
    const auth = req.auth;
    const pool = getPool();
    const user = await getUserById(auth.userId);
    if (!user)
        return sendError(reply, 401, "UNAUTHORIZED", "Account no longer exists.");
    const secret = authenticator.generateSecret();
    // Stored with totp_enabled=false until /2fa/enable verifies a code against it.
    await pool.query("UPDATE users SET totp_secret = $1, updated_at = now() WHERE id = $2", [secret, user.id]);
    const otpauthUrl = authenticator.keyuri(user.email, "Genze", secret);
    return reply.send({ data: { otpauthUrl, secret } });
}
async function twoFaEnable(req, reply) {
    const auth = req.auth;
    const { code } = bodyOf(req);
    const user = await getUserById(auth.userId);
    if (!user)
        return sendError(reply, 401, "UNAUTHORIZED", "Account no longer exists.");
    if (!user.totp_secret) {
        return sendError(reply, 400, "VALIDATION_ERROR", "No 2FA setup in progress. Call /2fa/setup first.");
    }
    if (typeof code !== "string" || !authenticator.check(code.trim(), user.totp_secret)) {
        return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid two-factor code.");
    }
    await getPool().query("UPDATE users SET totp_enabled = true, updated_at = now() WHERE id = $1", [user.id]);
    return reply.send({ data: { ok: true } });
}
async function twoFaDisable(req, reply) {
    const auth = req.auth;
    const { code } = bodyOf(req);
    const user = await getUserById(auth.userId);
    if (!user)
        return sendError(reply, 401, "UNAUTHORIZED", "Account no longer exists.");
    if (!user.totp_enabled || !user.totp_secret) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Two-factor authentication is not enabled.");
    }
    if (typeof code !== "string" || !authenticator.check(code.trim(), user.totp_secret)) {
        return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid two-factor code.");
    }
    await getPool().query("UPDATE users SET totp_enabled = false, totp_secret = NULL, updated_at = now() WHERE id = $1", [
        user.id,
    ]);
    return reply.send({ data: { ok: true } });
}
// ---------------------------------------------------------------------------
// Google OAuth: GET /oauth/google -> 302 (or 503 NOT_CONFIGURED)
//              GET /oauth/google/callback -> 302 to ${APP_URL}/auth/callback
// ---------------------------------------------------------------------------
function oauthCallbackUrl(req) {
    const forwarded = req.headers["x-forwarded-proto"];
    const proto = (typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined) || req.protocol;
    return `${proto}://${req.headers.host}/api/v1/auth/oauth/google/callback`;
}
async function oauthGoogle(req, reply) {
    const config = loadConfig();
    if (!config.googleOAuthClientId || !config.googleOAuthClientSecret) {
        return sendError(reply, 503, "NOT_CONFIGURED", "Google login is not configured");
    }
    const query = (req.query ?? {});
    const country = normalizeCountry(query.country) ?? "US";
    const state = Buffer.from(JSON.stringify({ country, nonce: newEmailToken() }), "utf8").toString("base64url");
    const params = new URLSearchParams({
        client_id: config.googleOAuthClientId,
        redirect_uri: oauthCallbackUrl(req),
        response_type: "code",
        scope: "openid email profile",
        state,
        access_type: "online",
        prompt: "select_account",
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}
async function oauthGoogleCallback(req, reply) {
    const config = loadConfig();
    if (!config.googleOAuthClientId || !config.googleOAuthClientSecret) {
        return sendError(reply, 503, "NOT_CONFIGURED", "Google login is not configured");
    }
    const query = (req.query ?? {});
    const code = typeof query.code === "string" ? query.code : "";
    if (!code)
        return sendError(reply, 400, "VALIDATION_ERROR", "Missing authorization code.");
    let country = "US";
    try {
        const state = JSON.parse(Buffer.from(String(query.state ?? ""), "base64url").toString("utf8"));
        country = normalizeCountry(state.country) ?? "US";
    }
    catch {
        // Unparseable state -> default country; the code exchange still decides.
    }
    const redirectUri = oauthCallbackUrl(req);
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: config.googleOAuthClientId,
            client_secret: config.googleOAuthClientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
        }),
    });
    if (!tokenRes.ok) {
        return sendError(reply, 400, "TOKEN_INVALID", "Google authentication failed. Please try again.");
    }
    const tokenJson = (await tokenRes.json());
    if (!tokenJson.access_token) {
        return sendError(reply, 400, "TOKEN_INVALID", "Google authentication failed. Please try again.");
    }
    const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    if (!infoRes.ok) {
        return sendError(reply, 400, "TOKEN_INVALID", "Could not read your Google profile.");
    }
    const info = (await infoRes.json());
    const email = typeof info.email === "string" ? info.email.trim().toLowerCase() : "";
    if (!email || !isValidEmail(email)) {
        return sendError(reply, 400, "TOKEN_INVALID", "Google did not return a valid email address.");
    }
    if (!info.email_verified) {
        return sendError(reply, 400, "TOKEN_INVALID", "Your Google account email is not verified.");
    }
    const pool = getPool();
    let user = (await pool.query("SELECT * FROM users WHERE email = $1", [email])).rows[0];
    if (user) {
        // Link: an existing password account with the same email keeps working;
        // Google has verified ownership of the address.
        await pool.query("UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1", [user.id]);
    }
    else {
        const id = uuidv4();
        await pool.query("INSERT INTO users (id, email, password_hash, email_verified, country) VALUES ($1, $2, NULL, true, $3)", [id, email, country]);
        user = (await getUserById(id));
    }
    const { accessToken, refreshToken } = await createSession(user.id, req);
    const dest = `${config.appUrl}/auth/callback` +
        `?accessToken=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}`;
    return reply.redirect(dest);
}
// ---------------------------------------------------------------------------
// POST /apple { identityToken, nonce? } -> 200 tokens+user
// Sign in with Apple (mobile). The token is verified server-side against
// Apple's JWKS (RS256; iss=https://appleid.apple.com; aud=APPLE_CLIENT_ID;
// exp in future; nonce match when provided). Fail closed: APPLE_CLIENT_ID
// unset -> 503 APPLE_NOT_CONFIGURED.
// ---------------------------------------------------------------------------
async function appleLogin(req, reply) {
    const { identityToken, nonce } = bodyOf(req);
    if (typeof identityToken !== "string" || !identityToken) {
        return sendError(reply, 400, "VALIDATION_ERROR", "An Apple identity token is required.");
    }
    if (nonce !== undefined && typeof nonce !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "Invalid nonce.");
    }
    const config = loadConfig();
    if (!config.appleClientId) {
        return sendError(reply, 503, "APPLE_NOT_CONFIGURED", "Sign in with Apple isn't set up yet. Please use email login for now.");
    }
    let claims;
    try {
        claims = await appleHooks.verify(identityToken, nonce);
    }
    catch (err) {
        if (err instanceof AppleTokenError || (err instanceof Error && err.message === "APPLE_CLIENT_ID is not set")) {
            return sendError(reply, 401, "INVALID_CREDENTIALS", "Apple sign-in didn't work. Please try again.");
        }
        throw err;
    }
    const { userId } = await findOrCreateAppleUser(claims.sub, claims.email);
    const user = await getUserById(userId);
    if (!user)
        return sendError(reply, 401, "UNAUTHORIZED", "Account no longer exists.");
    const { accessToken, refreshToken } = await createSession(user.id, req);
    return reply.send({ data: { tokens: { accessToken, refreshToken }, user: toPublicUser(user) } });
}
// ---------------------------------------------------------------------------
export async function authRoutes(app) {
    app.post("/signup", { config: STRICT_RATE_LIMIT }, signup);
    app.post("/verify-email", { config: VERIFY_RATE_LIMIT }, verifyEmail);
    app.post("/login", { config: STRICT_RATE_LIMIT }, login);
    app.post("/login/2fa", { config: STRICT_RATE_LIMIT }, login2fa);
    app.post("/refresh", refresh);
    app.post("/logout", { preHandler: authenticate }, logout);
    app.post("/logout-all", { preHandler: authenticate }, logoutAll);
    app.post("/forgot-password", { config: STRICT_RATE_LIMIT }, forgotPassword);
    app.post("/reset-password", { config: STRICT_RATE_LIMIT }, resetPassword);
    app.get("/devices", { preHandler: authenticate }, devices);
    app.post("/2fa/setup", { preHandler: authenticate }, twoFaSetup);
    app.post("/2fa/enable", { preHandler: authenticate }, twoFaEnable);
    app.post("/2fa/disable", { preHandler: authenticate }, twoFaDisable);
    app.get("/oauth/google", oauthGoogle);
    app.get("/oauth/google/callback", oauthGoogleCallback);
    app.post("/apple", { config: STRICT_RATE_LIMIT }, appleLogin);
}
//# sourceMappingURL=auth.js.map