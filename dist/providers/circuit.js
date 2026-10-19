// In-memory circuit breaker (Step 5).
//
// Consecutive provider failures at or above CIRCUIT_BREAKER_THRESHOLD
// (default 5) auto-disable the provider for CIRCUIT_BREAKER_COOLDOWN_MS
// (default 15 min). Any success resets the counter. The trip is treated like
// a DB kill: routing excludes the provider and the admin view shows
// killedBy "db" with the stored reason; the trip auto-clears when the
// cooldown elapses.
//
// Failures are recorded at the two provider choke points: completeWithProvider
// (research runner, write generation, compaction) and the chat streaming core
// (runChatStream). Client aborts never count; the demo provider never counts.
//
// Process-local in v1 — a real queue/fan-out (multi-instance) arrives with the
// agent step (documented limitation).
const states = new Map();
/** Injectable clock (tests use a manual clock instead of sleeping). */
let nowMs = () => Date.now();
/** Test hook: inject a fake clock. */
export function setCircuitClock(fn) {
    nowMs = fn;
}
/** Test hook: restore the real clock. */
export function resetCircuitClock() {
    nowMs = () => Date.now();
}
/** Test hook: drop all breaker state. */
export function resetCircuit() {
    states.clear();
}
function stateFor(id) {
    let s = states.get(id);
    if (!s) {
        s = { consecutiveFailures: 0, trippedUntilMs: null, reason: null };
        states.set(id, s);
    }
    return s;
}
function threshold() {
    const raw = (process.env.CIRCUIT_BREAKER_THRESHOLD ?? "").trim();
    const n = raw ? Number(raw) : NaN;
    return Number.isInteger(n) && n > 0 ? n : 5;
}
function cooldownMs() {
    const raw = (process.env.CIRCUIT_BREAKER_COOLDOWN_MS ?? "").trim();
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 900000;
}
/**
 * True while the provider is tripped. Auto-clears once the cooldown has
 * elapsed (state is dropped so the provider recovers cleanly).
 */
export function isCircuitTripped(id) {
    const s = states.get(id);
    if (!s || s.trippedUntilMs === null)
        return false;
    if (nowMs() >= s.trippedUntilMs) {
        states.delete(id);
        return false;
    }
    return true;
}
/** Any success resets the failure counter (and clears a fresh state). */
export function recordProviderSuccess(id) {
    states.delete(id);
}
/** Record one provider failure; trips the breaker at the threshold. */
export function recordProviderFailure(id, err) {
    if (isCircuitTripped(id))
        return; // already tripped — don't extend the trip
    const s = stateFor(id);
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= threshold()) {
        s.trippedUntilMs = nowMs() + cooldownMs();
        s.reason =
            err instanceof Error && err.message ? err.message.slice(0, 200) : "Repeated provider failures.";
        s.consecutiveFailures = 0;
    }
}
/** For the admin view: trip reason + auto-clear time; nulls when not tripped. */
export function circuitTripInfo(id) {
    if (!isCircuitTripped(id))
        return { tripped: false, reason: null, trippedUntil: null };
    const s = stateFor(id);
    return {
        tripped: true,
        reason: s.reason,
        trippedUntil: s.trippedUntilMs === null ? null : new Date(s.trippedUntilMs).toISOString(),
    };
}
//# sourceMappingURL=circuit.js.map