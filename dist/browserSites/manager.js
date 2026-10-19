// Step 8 — browser-based connections.
//
// For websites and apps that have NO usable API and NO MCP server (the
// fallback path Step 6 marked `fallback: "browser"`).
//
// The flow:
//   1. The user adds a site (name + URL) in the Connectors directory.
//   2. `beginLogin` opens a cloud browser on the site and returns a live
//      view URL. The user logs in THEMSELVES in that browser tab — Genze
//      never asks for, sees, or stores the password.
//   3. `completeLogin` captures the session's cookies, encrypts them into
//      `browser_sites.profile_blob`, and verifies the profile on a fresh
//      session before marking the site `active`.
//   4. Later, the agent (`openSiteSessionForTask`) can open the site already
//      logged in. Write actions stay behind the Step 7 approval gates;
//      every non-task path (login capture, health checks) is read-only by
//      construction — see ReadOnlyBrowserDriver below.
//   5. `checkHealth` re-verifies the session before use (or when stale) and
//      flips the site to `expired` with a plain-language "log in again"
//      prompt when the session is positively dead. Ambiguous pages never
//      nag the user (detection `unknown` keeps the current status).
//
// Security: profiles are AES-256-GCM encrypted per user (vault.ts, purpose
// label `genze:browser-profile:v1:` on the shared TOKEN_ENCRYPTION_KEY);
// every action is audited to `connector_audit_log` with
// `connector_id = "browser:<siteId>"` — one trail with the MCP connectors.
// Cookies/tokens never leave the server, never appear in logs or the UI.
// Disconnect destroys the profile.
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { loadConfig } from "../config.js";
import { ConnectorError, auditAction } from "../connectors/manager.js";
import { encryptProfile, decryptProfile } from "./vault.js";
import { recordUsage } from "../usage.js";
import { pickBrowserDriver, } from "../agent/browser.js";
export const BROWSER_AUDIT_PREFIX = "browser:";
/** Guided login sessions expire after 15 minutes (matches confirmation TTL). */
export const LOGIN_SESSION_TTL_MS = 15 * 60 * 1000;
/** A site whose last health check is older than this is re-checked before use. */
export const HEALTH_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
/** Same per-minute browser rate as the Step 7 agent runner. */
export const BROWSER_SITE_COST_PER_MINUTE_USD = 0.002;
function toBrowserSite(row) {
    return {
        id: row.id,
        name: row.name,
        url: row.url,
        status: row.status,
        lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
    };
}
function auditId(siteId) {
    return BROWSER_AUDIT_PREFIX + siteId;
}
/* ------------------------------------------------------------------ */
/* Driver selection (test seam)                                         */
/* ------------------------------------------------------------------ */
let driverFactory = null;
/**
 * Test seam: lets the suite inject a shared MockDriver so tests can
 * simulate the human login step (the mock "logs in" by visiting its
 * scripted login URL). Production leaves this unset -> pickBrowserDriver().
 */
export function setBrowserDriverFactoryForTest(fn) {
    driverFactory = fn;
}
function getDriver() {
    return driverFactory ? driverFactory() : pickBrowserDriver();
}
/* ------------------------------------------------------------------ */
/* Read-only driver wrapper                                             */
/* ------------------------------------------------------------------ */
/**
 * Wraps a driver so `act()` always throws. Login capture and health checks
 * open sessions through this wrapper: those paths can never click, type,
 * or otherwise change anything on the site — even if a future edit adds
 * an act() call by mistake. Write-capable sessions only exist inside
 * agent tasks (openSiteSessionForTask), where the Step 7 approval gates
 * (approval_required cards) cover every state-changing action.
 */
export class ReadOnlyBrowserDriver {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    get name() {
        return this.inner.name;
    }
    isConfigured() {
        return this.inner.isConfigured();
    }
    launch() {
        return this.inner.launch();
    }
    close(sessionId) {
        return this.inner.close(sessionId);
    }
    goto(sessionId, url) {
        return this.inner.goto(sessionId, url);
    }
    snapshot(sessionId) {
        return this.inner.snapshot(sessionId);
    }
    extract(sessionId, query) {
        return this.inner.extract(sessionId, query);
    }
    screenshot(sessionId) {
        if (!this.inner.screenshot)
            throw new Error("Screenshots are not supported by this browser.");
        return this.inner.screenshot(sessionId);
    }
    saveProfile(sessionId) {
        if (!this.inner.saveProfile)
            throw new Error("This browser can't save logins yet.");
        return this.inner.saveProfile(sessionId);
    }
    loadProfile(sessionId, blob) {
        if (!this.inner.loadProfile)
            throw new Error("This browser can't restore logins yet.");
        return this.inner.loadProfile(sessionId, blob);
    }
    async act(_sessionId, _instruction) {
        throw new ConnectorError(403, "BROWSER_WRITE_NOT_ALLOWED", "This browser view is read-only. Changes happen through the agent, which always asks first.");
    }
}
/* ------------------------------------------------------------------ */
/* Session-state detection                                              */
/* ------------------------------------------------------------------ */
const LOGGED_OUT_RE = /\b(log in|sign in|log into|sign into)\b/i;
const LOGGED_IN_RE = /\b(log out|sign out|my account|dashboard)\b/i;
/**
 * Heuristic over the page snapshot. `unknown` on anything ambiguous —
 * callers only ever demote on a positive `logged_out` and only ever
 * promote on a positive `logged_in`.
 */
export function detectSessionState(snapshot) {
    const hay = `${snapshot.title}\n${snapshot.text}\n${snapshot.a11yTree}`;
    const loggedOut = LOGGED_OUT_RE.test(hay);
    const loggedIn = LOGGED_IN_RE.test(hay);
    if (loggedIn && !loggedOut)
        return "logged_in";
    if (loggedOut && !loggedIn)
        return "logged_out";
    return "unknown";
}
/** Background checks: never nag the user on an ambiguous page. */
function applyHealthResult(current, detection) {
    if (detection === "logged_in")
        return "active";
    if (detection === "logged_out")
        return "expired";
    return current;
}
/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */
/** Site URLs must be https — except loopback http in non-production (tests, local dev). */
export function validateSiteUrl(raw) {
    if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > 500) {
        throw new ConnectorError(400, "VALIDATION_ERROR", "Please enter a valid website address.");
    }
    let u;
    try {
        u = new URL(raw.trim());
    }
    catch {
        throw new ConnectorError(400, "VALIDATION_ERROR", "That doesn't look like a valid website address.");
    }
    if (u.protocol === "https:")
        return u.toString();
    if (u.protocol === "http:" && loadConfig().nodeEnv !== "production") {
        const host = u.hostname.toLowerCase();
        if (host === "localhost" || host === "127.0.0.1" || host === "::1")
            return u.toString();
    }
    throw new ConnectorError(400, "VALIDATION_ERROR", "The website address must start with https://");
}
function validateSiteName(raw) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name || name.length > 80) {
        throw new ConnectorError(400, "VALIDATION_ERROR", "Please give the website a name (1–80 characters).");
    }
    return name;
}
/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */
async function requireSite(userId, siteId) {
    const r = await getPool().query(`SELECT id, name, url, profile_blob, status, last_checked_at, created_at
     FROM browser_sites WHERE id = $1 AND user_id = $2`, [siteId, userId]);
    const row = r.rows[0];
    if (!row)
        throw new ConnectorError(404, "NOT_FOUND", "That website wasn't found.");
    return row;
}
export async function addSite(userId, input) {
    const name = validateSiteName(input.name);
    const url = validateSiteUrl(input.url);
    const id = uuidv4();
    try {
        await getPool().query(`INSERT INTO browser_sites (id, user_id, name, url) VALUES ($1, $2, $3, $4)`, [id, userId, name, url]);
    }
    catch (err) {
        if (err.code === "23505") {
            throw new ConnectorError(409, "CONFLICT", "You've already added this website.");
        }
        throw err;
    }
    await auditAction(userId, auditId(id), "site_added", { name, url });
    return toBrowserSite(await requireSite(userId, id));
}
export async function listSites(userId) {
    const r = await getPool().query(`SELECT id, name, url, profile_blob, status, last_checked_at, created_at
     FROM browser_sites WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
    return r.rows.map(toBrowserSite);
}
export async function getSite(userId, siteId) {
    return toBrowserSite(await requireSite(userId, siteId));
}
export async function disconnectSite(userId, siteId) {
    await requireSite(userId, siteId);
    await cancelLoginForSite(userId, siteId);
    // Disconnect = the saved login is destroyed. The site entry stays so
    // re-login is one tap; the audit trail keeps the history.
    await getPool().query(`UPDATE browser_sites
     SET profile_blob = NULL, status = 'never', last_checked_at = NULL, updated_at = now()
     WHERE id = $1`, [siteId]);
    await auditAction(userId, auditId(siteId), "disconnected", {});
    return { disconnected: true };
}
/** Driver instances are stateful (CDP connections), so they are cached here
 *  between beginLogin and completeLogin. A server restart orphans them —
 *  the boot sweep deletes the rows and the driver sessions expire
 *  server-side (Steel) or are no-ops (mock). */
const activeLogins = new Map();
function requireProfileSupport(driver) {
    if (typeof driver.saveProfile !== "function" || typeof driver.loadProfile !== "function") {
        throw new ConnectorError(502, "BROWSER_PROFILE_UNSUPPORTED", "This browser can't save logins yet. Please try again later.");
    }
}
function requireConfigured(driver) {
    if (!driver.isConfigured()) {
        throw new ConnectorError(503, "BROWSER_NOT_CONFIGURED", "The browser service isn't set up yet. Please try again later.");
    }
}
async function meterBrowserUse(userId, driverName, startedAt, kind, siteId) {
    const minutes = Math.max((Date.now() - startedAt) / 60000, 1 / 60);
    try {
        await recordUsage({
            userId,
            feature: "browser_site",
            provider: driverName,
            units: minutes,
            costUsd: minutes * BROWSER_SITE_COST_PER_MINUTE_USD,
            details: { kind, siteId },
        });
    }
    catch (err) {
        // Metering must never break the user-facing flow.
        console.warn("[browser-sites] metering write failed:", err?.message ?? err);
    }
}
/** Close the driver session, drop the cache entry, delete the DB row, meter. */
async function finishLoginAttempt(loginId, active) {
    if (active) {
        await active.driver.close(active.driverSessionId).catch(() => { });
        activeLogins.delete(loginId);
        await meterBrowserUse(active.userId, active.driver.name, active.startedAt, "login_session", active.siteId);
    }
    await getPool().query(`DELETE FROM browser_login_sessions WHERE id = $1`, [loginId]);
}
async function cancelLoginForSite(userId, siteId) {
    const r = await getPool().query(`SELECT id FROM browser_login_sessions WHERE user_id = $1 AND site_id = $2`, [userId, siteId]);
    for (const row of r.rows) {
        await finishLoginAttempt(row.id, activeLogins.get(row.id) ?? null);
    }
}
/**
 * Opens the site in a cloud browser and returns the live view URL. The user
 * logs in themselves in that tab; Genze never sees the password.
 */
export async function beginLogin(userId, siteId) {
    const site = await requireSite(userId, siteId);
    const driver = getDriver();
    requireConfigured(driver);
    requireProfileSupport(driver);
    // One active login per site: a new attempt replaces the old one.
    await cancelLoginForSite(userId, siteId);
    const session = await driver.launch();
    const startedAt = Date.now();
    try {
        await driver.goto(session.id, site.url);
    }
    catch (err) {
        await driver.close(session.id).catch(() => { });
        throw new ConnectorError(502, "BROWSER_ERROR", "The browser couldn't open that website. Please check the address and try again.");
    }
    const loginId = uuidv4();
    const expiresAt = new Date(Date.now() + LOGIN_SESSION_TTL_MS);
    await getPool().query(`INSERT INTO browser_login_sessions (id, user_id, site_id, driver_session_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)`, [loginId, userId, siteId, session.id, expiresAt.toISOString()]);
    activeLogins.set(loginId, {
        driver,
        driverSessionId: session.id,
        siteId,
        userId,
        startedAt,
        expiresAt: expiresAt.getTime(),
    });
    await auditAction(userId, auditId(siteId), "login_started", {});
    return {
        loginSessionId: loginId,
        liveViewUrl: session.liveViewUrl,
        expiresAt: expiresAt.toISOString(),
    };
}
/**
 * Captures the login from the guided session, encrypts it, and verifies it
 * on a fresh session before marking the site active. The capture session is
 * read-only: snapshot/extract only, never act().
 */
export async function completeLogin(userId, siteId, loginSessionId) {
    await requireSite(userId, siteId);
    const r = await getPool().query(`SELECT id, driver_session_id, expires_at FROM browser_login_sessions
     WHERE id = $1 AND user_id = $2 AND site_id = $3`, [loginSessionId, userId, siteId]);
    const login = r.rows[0];
    if (!login)
        throw new ConnectorError(404, "NOT_FOUND", "That login session wasn't found.");
    const active = activeLogins.get(loginSessionId) ?? null;
    if (new Date(login.expires_at).getTime() < Date.now() || !active) {
        await finishLoginAttempt(loginSessionId, active);
        throw new ConnectorError(410, "LOGIN_SESSION_EXPIRED", "That login session expired. Please start the login again.");
    }
    const { driver, driverSessionId } = active;
    let blob;
    try {
        blob = (await new ReadOnlyBrowserDriver(driver).saveProfile(driverSessionId)) ?? "";
    }
    catch {
        await finishLoginAttempt(loginSessionId, active);
        throw new ConnectorError(502, "BROWSER_ERROR", "Couldn't save the login from that browser session. Please try again.");
    }
    if (!blob) {
        await finishLoginAttempt(loginSessionId, active);
        throw new ConnectorError(502, "BROWSER_ERROR", "Couldn't save the login from that browser session. Please try again.");
    }
    const encrypted = encryptProfile(blob);
    // Verify the captured profile on a fresh session (read-only).
    const detection = await withLoggedInSession(userId, siteId, encrypted, async (roDriver, freshSessionId, url) => {
        await roDriver.goto(freshSessionId, url);
        return detectSessionState(await roDriver.snapshot(freshSessionId));
    }, driver);
    // The user literally just logged in: trust a fresh login on ambiguity,
    // but never mark active when the check positively sees a logged-out page.
    const status = detection === "logged_out" ? "expired" : "active";
    await getPool().query(`UPDATE browser_sites
     SET profile_blob = $1, status = $2, last_checked_at = now(), updated_at = now()
     WHERE id = $3`, [encrypted, status, siteId]);
    await finishLoginAttempt(loginSessionId, active);
    await auditAction(userId, auditId(siteId), "login_completed", { status, detection });
    return { status, detection };
}
/**
 * Opens a logged-in session through the read-only wrapper: goto/snapshot/
 * extract/saveProfile only. Used by login verification and health checks.
 * The optional driverOverride keeps the login-capture session on the same
 * driver instance that began it (drivers are stateful).
 */
async function withLoggedInSession(userId, siteId, encryptedProfile, fn, driverOverride) {
    const site = await requireSite(userId, siteId);
    const driver = driverOverride ?? getDriver();
    requireConfigured(driver);
    requireProfileSupport(driver);
    let profile;
    try {
        profile = decryptProfile(encryptedProfile);
    }
    catch {
        await getPool().query(`UPDATE browser_sites SET status = 'expired', updated_at = now() WHERE id = $1`, [siteId]);
        await auditAction(userId, auditId(siteId), "session_expired", { reason: "unreadable_profile" });
        throw new ConnectorError(409, "BROWSER_SESSION_EXPIRED", `Your login to ${site.name} stopped working. Please log in again.`);
    }
    const ro = new ReadOnlyBrowserDriver(driver);
    const session = await driver.launch();
    const startedAt = Date.now();
    try {
        await ro.loadProfile(session.id, profile);
        return await fn(ro, session.id, site.url);
    }
    finally {
        await driver.close(session.id).catch(() => { });
        await meterBrowserUse(userId, driver.name, startedAt, "read_session", siteId);
    }
}
/* ------------------------------------------------------------------ */
/* Health                                                               */
/* ------------------------------------------------------------------ */
/**
 * Lightweight session check: restore the profile, open the site, detect the
 * session state. Only a positive `logged_out` demotes the site to `expired`.
 */
export async function checkHealth(userId, siteId) {
    const site = await requireSite(userId, siteId);
    if (site.status === "never" || !site.profile_blob) {
        throw new ConnectorError(409, "BROWSER_NOT_LOGGED_IN", `You haven't logged in to ${site.name} yet.`);
    }
    const detection = await withLoggedInSession(userId, siteId, site.profile_blob, async (roDriver, sessionId, url) => {
        await roDriver.goto(sessionId, url);
        return detectSessionState(await roDriver.snapshot(sessionId));
    });
    const status = applyHealthResult(site.status, detection);
    await getPool().query(`UPDATE browser_sites SET status = $1, last_checked_at = now(), updated_at = now() WHERE id = $2`, [status, siteId]);
    await auditAction(userId, auditId(siteId), "health_checked", { status, detection });
    if (status === "expired" && site.status !== "expired") {
        await auditAction(userId, auditId(siteId), "session_expired", { detection });
    }
    return { status, detection };
}
/* ------------------------------------------------------------------ */
/* Agent use                                                            */
/* ------------------------------------------------------------------ */
const RUNNABLE_TASK_STATUSES = ["running", "awaiting_confirmation", "paused_takeover"];
/**
 * Opens the site logged in for an agent task. This is the ONLY path that
 * yields a write-capable driver — and it requires a live, user-owned,
 * runnable agent task, whose Step 7 approval gates (approval_required
 * cards) cover every state-changing browser action. Callers must close().
 */
export async function openSiteSessionForTask(userId, siteId, taskId) {
    const site = await requireSite(userId, siteId);
    const t = await getPool().query(`SELECT id, status FROM agent_tasks WHERE id = $1 AND user_id = $2`, [taskId, userId]);
    const task = t.rows[0];
    if (!task)
        throw new ConnectorError(404, "NOT_FOUND", "That task wasn't found.");
    if (!RUNNABLE_TASK_STATUSES.includes(task.status)) {
        throw new ConnectorError(409, "TASK_NOT_RUNNING", "That task isn't running anymore, so the website can't be opened for it.");
    }
    if (site.status === "never" || !site.profile_blob) {
        throw new ConnectorError(409, "BROWSER_NOT_LOGGED_IN", `You haven't logged in to ${site.name} yet.`);
    }
    // Re-check before use when the last check is stale (or the site is expired).
    const stale = site.status !== "active" ||
        !site.last_checked_at ||
        Date.now() - new Date(site.last_checked_at).getTime() > HEALTH_CHECK_TTL_MS;
    if (stale) {
        const { status } = await checkHealth(userId, siteId);
        if (status !== "active") {
            throw new ConnectorError(409, "BROWSER_SESSION_EXPIRED", `Your login to ${site.name} expired. Please log in again.`);
        }
    }
    const driver = getDriver();
    requireConfigured(driver);
    requireProfileSupport(driver);
    const profile = decryptProfile(site.profile_blob);
    const session = await driver.launch();
    const startedAt = Date.now();
    try {
        if (driver.loadProfile)
            await driver.loadProfile(session.id, profile);
        await driver.goto(session.id, site.url);
    }
    catch (err) {
        await driver.close(session.id).catch(() => { });
        throw new ConnectorError(502, "BROWSER_ERROR", `The browser couldn't open ${site.name} while logged in. Please try again.`);
    }
    await auditAction(userId, auditId(siteId), "site_used", { taskId });
    return {
        driver,
        sessionId: session.id,
        close: async () => {
            await driver.close(session.id).catch(() => { });
            await meterBrowserUse(userId, driver.name, startedAt, "task_session", siteId);
        },
    };
}
/* ------------------------------------------------------------------ */
/* Boot sweep                                                           */
/* ------------------------------------------------------------------ */
/**
 * Deletes expired guided-login rows and closes their driver sessions
 * best-effort (a fresh driver can close a Steel session by id; the mock
 * close is a no-op). Wired into the API boot sweep.
 */
export async function sweepStaleBrowserLogins() {
    const r = await getPool().query(`DELETE FROM browser_login_sessions WHERE expires_at < now()
     RETURNING id, driver_session_id`);
    if (r.rows.length === 0)
        return 0;
    const driver = getDriver();
    for (const row of r.rows) {
        const active = activeLogins.get(row.id);
        if (active) {
            await active.driver.close(active.driverSessionId).catch(() => { });
            activeLogins.delete(row.id);
        }
        else if (driver.isConfigured()) {
            // Orphaned by a restart: close by session id alone (Steel supports it).
            await driver.close(row.driver_session_id).catch(() => { });
        }
    }
    return r.rows.length;
}
//# sourceMappingURL=manager.js.map