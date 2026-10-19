// Input validation helpers shared by the auth routes.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(value) {
    return typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value.trim());
}
/** Uppercase ISO-3166-1 alpha-2 code, or null when invalid. */
export function normalizeCountry(value) {
    if (typeof value !== "string")
        return null;
    const cc = value.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(cc) ? cc : null;
}
/**
 * Contract: password >= 8 chars. The 72-char ceiling is bcrypt's own limit
 * (bcryptjs silently truncates past 72 bytes); rejecting longer passwords
 * keeps signup and login semantics identical.
 */
export function isValidPassword(value) {
    return typeof value === "string" && value.length >= 8 && value.length <= 72;
}
//# sourceMappingURL=validation.js.map