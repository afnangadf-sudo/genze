// Step 7 — Agent task runner.
//
// In-process background execution, mirroring the research runner (decision
// #42): no BullMQ in v1; the DB row is the source of truth; progress is
// written BEFORE the terminal status; AbortController map handles cancels.
//
// Two phases:
//   plan    — generate the step plan via the chat router (status 'planned'
//             → 'awaiting_approval'); failure → 'failed' with an honest error.
//   execute — approve → 'running': launch the browser, work the plan step by
//             step. Risky actions pause for explicit approval
//             ('awaiting_confirmation'); takeover pauses the loop
//             ('paused_takeover'). Terminal: done | failed | cancelled |
//             limit_stopped — ALWAYS exactly one notification row + one
//             metering row (feature='agent').
//
// Boundaries (see guards.ts): risky actions never execute without approval;
// untrusted page content is always wrapped (wrapUntrusted) and scanned
// (containsInjectionProbe) — a probe is logged + flagged in the report, NEVER
// followed.
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { pickBrowserDriver, MOCK_SEARCH_URL, } from "./browser.js";
import { classifyActionRisk, containsInjectionProbe, wrapUntrusted, RISK_LABELS, } from "./guards.js";
import { routeChat, chatReplyCost, findChatModel } from "../providers/models.js";
import { makeChatProvider } from "../providers/instances.js";
import { isFreeEnabled, makeFreeProvider } from "../providers/free.js";
import { completeWithProvider } from "../providers/complete.js";
import { getUserCountry, hasLiveConsent } from "../users.js";
import { checkLimit } from "../limits.js";
import { spendCredits } from "../credits.js";
import { recordUsage } from "../usage.js";
const TERMINAL = ["done", "failed", "cancelled", "limit_stopped"];
/* ---------- lazy env caps ---------- */
function envInt(name, def) {
    const raw = process.env[name];
    if (raw === undefined || raw === "")
        return def;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : def;
}
function envFloat(name, def) {
    const raw = process.env[name];
    if (raw === undefined || raw === "")
        return def;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : def;
}
export const agentMaxSteps = () => envInt("AGENT_MAX_STEPS", 30);
export const agentMaxMinutes = () => envInt("AGENT_MAX_MINUTES", 15);
export const agentMaxSpendUsd = () => envFloat("AGENT_MAX_SPEND_USD", 2);
/** Browser cost estimate per minute (Steel ~$0.10/browser-hr per research). */
export const BROWSER_COST_PER_MINUTE_USD = 0.002;
/* ---------- registries ---------- */
const activeTasks = new Set();
const aborters = new Map();
const takeoverPaused = new Set();
/** Waiters woken immediately when an approval is decided (routes call resumeAgentTask). */
const approvalWaiters = new Map();
/**
 * Folder-scope seam for the sibling worker. The real guard
 * `checkFolderScope(taskProjectId, fileProjectId)` will live in
 * `../agent/scope.js` (do NOT create scope.ts here). Until then, this throws
 * whenever a task scoped to a project would attach a file from another
 * project — fail closed.
 */
export function assertScopeAllows(task, fileProjectId) {
    if (task.project_id && fileProjectId && task.project_id !== fileProjectId) {
        throw new Error("SCOPE_VIOLATION");
    }
}
/** The swappable enqueue seam: today, run in this process. */
export function enqueueAgentTask(taskId) {
    setImmediate(() => {
        void runAgentTask(taskId);
    });
}
/**
 * Start (or resume) a task run. Called by the approve route and by the
 * sibling worker's scheduler — the seam they own.
 */
export function startAgentTask(taskId) {
    if (activeTasks.has(taskId))
        return;
    enqueueAgentTask(taskId);
}
/** Abort a live run (cancel route). The runner's abort path finalizes. */
export function abortAgentTask(taskId) {
    aborters.get(taskId)?.abort();
}
/** Pause the step loop for a human takeover (route sets the DB status too). */
export function pauseForTakeover(taskId) {
    takeoverPaused.add(taskId);
}
/** Release a takeover pause; the loop continues on its next step check. */
export function resumeFromTakeover(taskId) {
    takeoverPaused.delete(taskId);
}
/** Wake the approval waiter immediately (the decide route calls this). */
export function resumeAgentTask(taskId) {
    const waiters = approvalWaiters.get(taskId);
    if (waiters) {
        approvalWaiters.delete(taskId);
        for (const w of waiters)
            w();
    }
}
/**
 * Boot sweep: tasks stuck in live statuses (the process died mid-run) fail
 * honestly instead of hanging forever. Mirrors research sweepStaleJobs.
 */
export async function sweepStaleAgentTasks() {
    const r = await getPool().query(`UPDATE agent_tasks SET status = 'failed',
       error = 'The server restarted while this task was running. Please start it again.',
       finished_at = now(), updated_at = now()
     WHERE status IN ('running', 'awaiting_confirmation', 'paused_takeover')`);
    return r.rowCount ?? 0;
}
/* ---------- small helpers ---------- */
async function loadTask(taskId) {
    const r = await getPool().query("SELECT * FROM agent_tasks WHERE id = $1", [
        taskId,
    ]);
    return r.rowCount ? r.rows[0] : null;
}
async function setStatus(taskId, status, extra) {
    if (extra !== undefined) {
        await getPool().query("UPDATE agent_tasks SET status = $1, error = $2, updated_at = now() WHERE id = $3", [status, extra, taskId]);
    }
    else {
        await getPool().query("UPDATE agent_tasks SET status = $1, updated_at = now() WHERE id = $2", [status, taskId]);
    }
}
async function writeAudit(userId, taskId, action, details) {
    await getPool().query("INSERT INTO connector_audit_log (id, user_id, connector_id, action, details) VALUES ($1, $2, 'agent', $3, $4::jsonb)", [uuidv4(), userId, action, JSON.stringify({ taskId, ...details })]);
}
/** Exactly one notification per task (guarded at the SQL level). */
async function notifyOnce(task, title) {
    await getPool().query(`INSERT INTO agent_notifications (id, user_id, task_id, title)
     SELECT $1, $2, $3, $4
     WHERE NOT EXISTS (SELECT 1 FROM agent_notifications WHERE task_id = $3)`, [uuidv4(), task.user_id, task.id, title]);
}
async function closeBrowserSession(task, driver) {
    if (!driver || !task.browser_session_id)
        return;
    try {
        await driver.close(task.browser_session_id);
    }
    catch {
        // best effort
    }
    await getPool().query("UPDATE agent_tasks SET browser_session_id = NULL WHERE id = $1", [
        task.id,
    ]);
}
/** Attach a produced file to the task (folder-scope checked). */
export async function attachResultFile(task, file) {
    assertScopeAllows(task, file.projectId ?? null);
    await getPool().query("UPDATE agent_tasks SET result_files = result_files || $1::jsonb, updated_at = now() WHERE id = $2", [JSON.stringify([{ ...file, attachedAt: new Date().toISOString() }]), task.id]);
}
/* ---------- plan generation ---------- */
const PLANNER_SYSTEM = "You are an agent planner. Break the user's task into concrete browser " +
    "steps. Reply with JSON only.";
function extractJson(text) {
    const t = (text ?? "").trim();
    if (!t)
        return null;
    try {
        return JSON.parse(t);
    }
    catch {
        // fall through
    }
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start === -1 || end <= start)
        return null;
    try {
        return JSON.parse(t.slice(start, end + 1));
    }
    catch {
        return null;
    }
}
function parsePlan(text) {
    const v = extractJson(text);
    if (!v || typeof v !== "object")
        return null;
    const o = v;
    if (!Array.isArray(o.steps))
        return null;
    const steps = [];
    for (const s of o.steps) {
        if (!s || typeof s !== "object")
            continue;
        const so = s;
        const action = so.action;
        if (action !== "goto" && action !== "act" && action !== "extract")
            continue;
        const description = typeof so.description === "string" ? so.description.trim() : "";
        if (!description)
            continue;
        steps.push({
            n: steps.length + 1,
            action,
            url: typeof so.url === "string" ? so.url : undefined,
            description,
        });
    }
    if (steps.length < 1 || steps.length > agentMaxSteps())
        return null;
    return {
        steps,
        estimatedMinutes: typeof o.estimatedMinutes === "number" ? o.estimatedMinutes : steps.length,
        estimatedCostUsd: typeof o.estimatedCostUsd === "number" ? o.estimatedCostUsd : 0,
        requiresBrowser: o.requiresBrowser !== false,
    };
}
async function planPhase(task, signal) {
    const country = await getUserCountry(task.user_id);
    const route = country ? routeChat({ country, taskType: "reasoning" }) : null;
    let provider;
    let model;
    if (!route) {
        // Keyless: the agent plans with the free AI provider (real answers, zero
        // keys). Consent is required because the task text leaves the server.
        // Browser steps still need the Steel key at execution time.
        if (!isFreeEnabled() || !(await hasLiveConsent(task.user_id, "free"))) {
            throw new Error("No agent provider is available for your region right now. Please try again later.");
        }
        provider = makeFreeProvider();
        // Honest zero-cost model record for the keyless path (never billed).
        model = {
            id: "free",
            provider: "openai",
            inputPerM: 0,
            outputPerM: 0,
            context: 8192,
            taskTypes: ["reasoning"],
        };
    }
    else {
        if (!(await hasLiveConsent(task.user_id, route.provider))) {
            throw new Error("Permission to use the AI helper was withdrawn, so the plan can't be made.");
        }
        // routeChat only ever returns chat-implemented providers (anthropic|openai).
        provider = makeChatProvider(route.provider, route.model.id);
        model = route.model;
    }
    const user = `Task: ${task.task}\n\n` +
        `Return ONLY a JSON object like:\n` +
        `{"steps": [{"action": "goto", "url": "https://…", "description": "Open the product page"}, ` +
        `{"action": "act", "description": "Click the Buy now button"}, ` +
        `{"action": "extract", "description": "Read the order total"}], ` +
        `"estimatedMinutes": 3, "estimatedCostUsd": 0.05, "requiresBrowser": true}\n` +
        `Actions are only goto (needs url), act (a browser action described in words), or extract (read the page). ` +
        `No other text.`;
    let inputTokens = 0;
    let outputTokens = 0;
    let r = await completeWithProvider(provider, {
        system: PLANNER_SYSTEM,
        messages: [{ role: "user", content: user }],
        signal,
    });
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    let plan = parsePlan(r.text);
    if (!plan) {
        r = await completeWithProvider(provider, {
            system: PLANNER_SYSTEM,
            messages: [
                {
                    role: "user",
                    content: "Your previous reply was not valid JSON. Return ONLY the JSON object.\n\n" + user,
                },
            ],
            signal,
        });
        inputTokens += r.inputTokens;
        outputTokens += r.outputTokens;
        plan = parsePlan(r.text);
    }
    if (!plan)
        throw new Error("The task plan could not be generated. Please try again.");
    return { plan, inputTokens, outputTokens, model };
}
const BROWSER_TOOLS = [
    {
        name: "browser_goto",
        description: "Navigate the browser to a URL.",
        inputSchema: {
            type: "object",
            properties: { url: { type: "string" }, description: { type: "string" } },
            required: ["url", "description"],
        },
    },
    {
        name: "browser_act",
        description: "Do one browser action. instruction is JSON: {\"op\":\"click\",\"target\":\"button label\"} or {\"op\":\"type\",\"target\":\"field label\",\"text\":\"…\"} or {\"op\":\"key\",\"key\":\"Enter\"}.",
        inputSchema: {
            type: "object",
            properties: { instruction: { type: "string" }, description: { type: "string" } },
            required: ["instruction", "description"],
        },
    },
    {
        name: "browser_extract",
        description: "Read the current page's text.",
        inputSchema: {
            type: "object",
            properties: { query: { type: "string" }, description: { type: "string" } },
            required: ["query", "description"],
        },
    },
    {
        name: "task_done",
        description: "The task is complete. Stop the run.",
        inputSchema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
        },
    },
];
const DECIDER_SYSTEM = "You are a browser agent. Look at the task, the plan, and the latest page " +
    "snapshot, then choose the single next browser action. Reply with JSON only.";
function toolCallToDecision(calls) {
    const c = calls[0];
    if (!c)
        return null;
    const input = c.input ?? {};
    const str = (v) => (typeof v === "string" ? v : undefined);
    if (c.name === "browser_goto" && str(input.url)) {
        return { action: "goto", url: str(input.url), description: str(input.description) ?? `Open ${input.url}` };
    }
    if (c.name === "browser_act" && str(input.instruction)) {
        return {
            action: "act",
            instruction: str(input.instruction),
            description: str(input.description) ?? "Do a browser action",
        };
    }
    if (c.name === "browser_extract") {
        return {
            action: "extract",
            query: str(input.query) ?? "",
            description: str(input.description) ?? "Read the page",
        };
    }
    if (c.name === "task_done") {
        return { action: "done", description: "Done", summary: str(input.summary) };
    }
    return null;
}
async function decideNextAction(provider, signal, args) {
    const snapshotBlock = args.snapshot
        ? wrapUntrusted(args.snapshot.url, `Title: ${args.snapshot.title}\n${args.snapshot.text}\nInteractive elements:\n${args.snapshot.a11yTree}`)
        : "(no page open yet)";
    const context = `Task: ${args.task.task}\n\n` +
        `Plan:\n${args.plan.steps.map((s) => `${s.n}. [${s.action}] ${s.description}${s.url ? ` (${s.url})` : ""}`).join("\n")}\n\n` +
        `Steps used: ${args.task.steps_used}. Actions so far:\n${args.history.length ? args.history.map((h, i) => `${i + 1}. ${h}`).join("\n") : "(none)"}\n\n` +
        `Latest page snapshot:\n${snapshotBlock}`;
    if (typeof provider.decideToolCalls === "function") {
        const r = await provider.decideToolCalls({
            system: DECIDER_SYSTEM,
            messages: [{ role: "user", content: context }],
            tools: BROWSER_TOOLS,
            signal,
            maxTokens: 500,
        });
        const d = toolCallToDecision(r.toolCalls);
        if (d)
            return { decision: d, inputTokens: 0, outputTokens: 0 };
    }
    // Fallback: plain JSON decision prompt (providers without native tools).
    const r = await completeWithProvider(provider, {
        system: DECIDER_SYSTEM +
            ' Reply with ONLY JSON: {"action":"goto","url":"\u2026","description":"\u2026"} or ' +
            '{"action":"act","instruction":"{\\\"op\\\":\\\"click\\\",\\\"target\\\":\\\"\u2026\\\"}","description":"\u2026"} or ' +
            '{"action":"extract","query":"\u2026","description":"\u2026"} or {"action":"done","summary":"\u2026"}',
        messages: [{ role: "user", content: context }],
        signal,
    });
    const v = extractJson(r.text);
    const action = v?.action;
    let decision = null;
    if (action === "goto" && typeof v?.url === "string") {
        decision = { action, url: v.url, description: String(v.description ?? `Open ${v.url}`) };
    }
    else if (action === "act" && typeof v?.instruction === "string") {
        decision = { action, instruction: v.instruction, description: String(v.description ?? "Do a browser action") };
    }
    else if (action === "extract") {
        decision = { action, query: String(v?.query ?? ""), description: String(v?.description ?? "Read the page") };
    }
    else if (action === "done") {
        decision = { action, description: "Done", summary: String(v?.summary ?? "") };
    }
    if (!decision)
        throw new Error("The agent could not decide its next step. Please try again.");
    return { decision, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
}
/** Scripted decisions for tests (mock driver): follow the plan steps in order. */
function scriptedDecision(task, stepIndex) {
    const plan = task.plan;
    const planStep = plan?.steps[stepIndex];
    if (!planStep)
        return { action: "done", description: "Done", summary: "Task complete." };
    if (planStep.action === "goto") {
        return { action: "goto", url: planStep.url ?? MOCK_SEARCH_URL, description: planStep.description };
    }
    if (planStep.action === "act") {
        return {
            action: "act",
            instruction: JSON.stringify({ op: "click", target: planStep.description }),
            description: planStep.description,
        };
    }
    return { action: "extract", query: "", description: planStep.description };
}
async function latestPendingApproval(taskId) {
    const r = await getPool().query(`SELECT id, kind, summary, status, expires_at FROM agent_approvals
     WHERE task_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [taskId]);
    return r.rowCount ? r.rows[0] : null;
}
function approvalSummary(kind, description, snapshot) {
    const label = RISK_LABELS[kind];
    const where = snapshot?.title ? ` on "${snapshot.title}"` : "";
    return (`The agent wants to ${description.charAt(0).toLowerCase()}${description.slice(1)}${where}. ` +
        `This may ${label}. Say yes to let it continue, or no to stop the task.`);
}
/**
 * Pause the loop until the approval is decided. Resolves 'approved' |
 * 'rejected' | 'expired'. Throws on abort.
 */
async function waitForApproval(taskId, approvalId, signal) {
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (v) => {
            if (done)
                return;
            done = true;
            clearInterval(timer);
            const ws = approvalWaiters.get(taskId);
            if (ws)
                approvalWaiters.set(taskId, ws.filter((w) => w !== wake));
            resolve(v);
        };
        const wake = () => {
            void check();
        };
        const check = async () => {
            if (signal.aborted) {
                if (!done) {
                    done = true;
                    clearInterval(timer);
                    reject(new Error("aborted"));
                }
                return;
            }
            const r = await getPool()
                .query("SELECT status, expires_at FROM agent_approvals WHERE id = $1", [approvalId])
                .catch(() => null);
            if (!r || !r.rowCount)
                return;
            const row = r.rows[0];
            if (row.status === "approved")
                return finish("approved");
            if (row.status === "rejected")
                return finish("rejected");
            if (new Date(row.expires_at).getTime() < Date.now())
                return finish("expired");
        };
        const list = approvalWaiters.get(taskId) ?? [];
        list.push(wake);
        approvalWaiters.set(taskId, list);
        const timer = setInterval(() => {
            void check();
        }, 2000);
        void check();
    });
}
/** Thrown to unwind the run on abort; the outer catch finalizes as cancelled. */
class AbortRun extends Error {
    constructor() {
        super("aborted");
        this.name = "AbortRun";
    }
}
async function finalizeTask(taskId, outcome, ctx) {
    const task = await loadTask(taskId);
    if (!task || TERMINAL.includes(task.status))
        return;
    const elapsedMin = (Date.now() - ctx.startedAt) / 60000;
    const browserCost = elapsedMin * BROWSER_COST_PER_MINUTE_USD;
    const costUsd = browserCost + ctx.llmCostUsd;
    // Everything observable is written BEFORE the terminal status (research
    // ordering guarantee): an observer that sees the terminal status always
    // finds the report, the notification, and the metering row already there.
    if (outcome.report !== undefined) {
        await getPool().query("UPDATE agent_tasks SET report_markdown = $1, updated_at = now() WHERE id = $2", [outcome.report, taskId]);
    }
    await closeBrowserSession({ ...task, status: outcome.status }, ctx.driver);
    const plainTitle = ctx.title.length > 60 ? `${ctx.title.slice(0, 57)}…` : ctx.title;
    const notificationTitle = outcome.status === "done"
        ? `Your agent task is done: ${plainTitle}`
        : outcome.status === "cancelled"
            ? `Your agent task was stopped: ${plainTitle}`
            : `Your agent task couldn't finish: ${plainTitle}`;
    await notifyOnce({ ...task, status: outcome.status }, notificationTitle);
    await recordUsage({
        userId: ctx.userId,
        feature: "agent",
        provider: null,
        units: Math.ceil(elapsedMin),
        costUsd,
        details: { taskId, steps: ctx.stepsUsed, outcome: outcome.status },
    });
    await setStatus(taskId, outcome.status, outcome.error);
    await getPool().query("UPDATE agent_tasks SET finished_at = now(), updated_at = now() WHERE id = $1", [
        taskId,
    ]);
}
/* ---------- the run ---------- */
export async function runAgentTask(taskId) {
    if (activeTasks.has(taskId))
        return; // a run is already in flight
    activeTasks.add(taskId);
    const startedAt = Date.now();
    let driver = null;
    let llmCostUsd = 0;
    try {
        let task = await loadTask(taskId);
        if (!task || TERMINAL.includes(task.status))
            return;
        const aborter = new AbortController();
        aborters.set(taskId, aborter);
        const signal = aborter.signal;
        const scripted = process.env.NODE_ENV === "test";
        try {
            /* ----- plan phase ----- */
            if (!task.plan) {
                if (!task.started_at) {
                    await getPool().query("UPDATE agent_tasks SET started_at = now() WHERE id = $1", [taskId]);
                }
                try {
                    const { plan, inputTokens, outputTokens, model } = await planPhase(task, signal);
                    llmCostUsd += chatReplyCost(model, inputTokens, outputTokens);
                    await getPool().query("UPDATE agent_tasks SET plan = $1::jsonb, status = 'awaiting_approval', updated_at = now() WHERE id = $2", [JSON.stringify(plan), taskId]);
                    await writeAudit(task.user_id, taskId, "plan_ready", { steps: plan.steps.length });
                }
                catch (err) {
                    if (signal.aborted || err instanceof AbortRun)
                        throw new AbortRun();
                    const message = err instanceof Error ? err.message : "The task plan could not be generated.";
                    await finalizeTask(taskId, { status: "failed", error: message }, { driver: null, userId: task.user_id, title: task.title, startedAt, stepsUsed: 0, llmCostUsd });
                }
                return;
            }
            /* ----- execute phase ----- */
            if (task.status !== "running" && task.status !== "awaiting_confirmation" && task.status !== "paused_takeover") {
                // Approved from 'planned' before the plan landed, or any stray state:
                // not our turn to execute.
                return;
            }
            // Consent re-check at execution start (a mid-run revocation stops new work).
            const country = await getUserCountry(task.user_id);
            const route = country ? routeChat({ country, taskType: "reasoning" }) : null;
            if (!route || !(await hasLiveConsent(task.user_id, route.provider))) {
                await finalizeTask(taskId, { status: "failed", error: "Permission to use the AI helper was withdrawn, so the task can't continue." }, { driver: null, userId: task.user_id, title: task.title, startedAt, stepsUsed: task.steps_used, llmCostUsd });
                return;
            }
            if (!task.started_at) {
                await getPool().query("UPDATE agent_tasks SET started_at = now() WHERE id = $1", [taskId]);
            }
            driver = pickBrowserDriver();
            if (!driver.isConfigured()) {
                await finalizeTask(taskId, { status: "failed", error: "The browser service is not set up, so the task can't run." }, { driver: null, userId: task.user_id, title: task.title, startedAt, stepsUsed: task.steps_used, llmCostUsd });
                return;
            }
            // routeChat with taskType 'reasoning' only ever returns chat-implemented
            // providers (anthropic|openai) — same cast as the research runner.
            const provider = makeChatProvider(route.provider, route.model.id);
            const session = await driver.launch();
            await getPool().query("UPDATE agent_tasks SET browser_session_id = $1, live_view_url = $2, updated_at = now() WHERE id = $3", [session.id, session.liveViewUrl, taskId]);
            await writeAudit(task.user_id, taskId, "browser_launched", { driver: driver.name });
            const history = [];
            const suspicious = [];
            const visited = [];
            let snapshot = null;
            let stepsUsed = task.steps_used;
            let minutesBilled = 0;
            const deadline = Date.now() + agentMaxMinutes() * 60_000;
            const maxSteps = agentMaxSteps();
            const maxSpend = agentMaxSpendUsd();
            const stopLimit = async (t, message) => {
                await finalizeTask(taskId, { status: "limit_stopped", error: message }, { driver, userId: t.user_id, title: t.title, startedAt, stepsUsed, llmCostUsd });
            };
            for (;;) {
                if (signal.aborted)
                    throw new AbortRun();
                // Takeover pause: the loop waits here until released.
                while (takeoverPaused.has(taskId)) {
                    if (signal.aborted)
                        throw new AbortRun();
                    await new Promise((r) => setTimeout(r, 500));
                }
                task = (await loadTask(taskId)) ?? task;
                if (!task || TERMINAL.includes(task.status))
                    return;
                // Per-task caps.
                const elapsedSec = (Date.now() - startedAt) / 1000;
                if (elapsedSec > agentMaxMinutes() * 60 || Date.now() > deadline) {
                    await stopLimit(task, `The task reached its ${agentMaxMinutes()}-minute limit, so it was stopped. Nothing was charged beyond that.`);
                    return;
                }
                if (stepsUsed >= maxSteps) {
                    await stopLimit(task, `The task reached its ${maxSteps}-step limit, so it was stopped. Nothing was charged beyond that.`);
                    return;
                }
                const spendSoFar = minutesBilled * BROWSER_COST_PER_MINUTE_USD + llmCostUsd;
                if (spendSoFar >= maxSpend) {
                    await stopLimit(task, "The task reached its spending limit, so it was stopped.");
                    return;
                }
                // Per started minute: 1 credit + quota check.
                const startedMinute = Math.floor(elapsedSec / 60) + 1;
                while (minutesBilled < startedMinute) {
                    minutesBilled += 1;
                    const okCredit = await spendCredits(task.user_id, 1, `agent:${taskId}:minute-${minutesBilled}`);
                    if (!okCredit) {
                        await stopLimit(task, "The task ran out of credits, so it was stopped. It will continue when credits refill.");
                        return;
                    }
                    const limit = await checkLimit(task.user_id, "agent", minutesBilled);
                    if (!limit.ok) {
                        await stopLimit(task, "The task reached today's agent time limit, so it was stopped. It resets at midnight (UTC).");
                        return;
                    }
                }
                // Decide the next action.
                let decision;
                if (scripted) {
                    decision = scriptedDecision({ ...task, steps_used: stepsUsed }, stepsUsed);
                }
                else {
                    const decided = await decideNextAction(provider, signal, {
                        task,
                        plan: task.plan,
                        history,
                        snapshot,
                    });
                    decision = decided.decision;
                    llmCostUsd += chatReplyCost(route.model, decided.inputTokens, decided.outputTokens);
                }
                await writeAudit(task.user_id, taskId, "decision", {
                    step: stepsUsed + 1,
                    action: decision.action,
                    description: decision.description,
                });
                if (decision.action === "done") {
                    const report = buildReport(task, history, visited, suspicious, decision.summary);
                    await getPool().query("UPDATE agent_tasks SET screenshots = $1::jsonb WHERE id = $2", [
                        JSON.stringify([]),
                        taskId,
                    ]);
                    await finalizeTask(taskId, { status: "done", report }, { driver, userId: task.user_id, title: task.title, startedAt, stepsUsed, llmCostUsd });
                    return;
                }
                // Risk gate: pause for explicit approval BEFORE executing.
                const riskText = `${decision.action} ${decision.description} ${decision.url ?? ""}`;
                const risks = classifyActionRisk(riskText);
                if (risks.length > 0) {
                    const kind = risks[0];
                    const approvalId = uuidv4();
                    const summary = approvalSummary(kind, decision.description, snapshot);
                    await getPool().query(`INSERT INTO agent_approvals (id, user_id, task_id, kind, summary, details)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [
                        approvalId,
                        task.user_id,
                        taskId,
                        kind,
                        summary,
                        JSON.stringify({
                            action: decision.action,
                            description: decision.description,
                            url: decision.url ?? null,
                            instruction: decision.instruction ?? null,
                            step: stepsUsed + 1,
                        }),
                    ]);
                    await setStatus(taskId, "awaiting_confirmation");
                    await writeAudit(task.user_id, taskId, "approval_requested", { kind, approvalId });
                    let verdict;
                    try {
                        verdict = await waitForApproval(taskId, approvalId, signal);
                    }
                    catch {
                        throw new AbortRun(); // aborted while waiting: outer catch finalizes
                    }
                    await writeAudit(task.user_id, taskId, "approval_decided", { verdict, approvalId });
                    if (verdict === "approved") {
                        await setStatus(taskId, "running");
                        // fall through to execute the approved action
                    }
                    else {
                        const msg = verdict === "expired"
                            ? "The approval request expired without an answer, so the task was stopped."
                            : "You said no to the risky step, so the task was stopped.";
                        await finalizeTask(taskId, { status: "cancelled", error: msg }, { driver, userId: task.user_id, title: task.title, startedAt, stepsUsed, llmCostUsd });
                        return;
                    }
                }
                // Execute.
                if (signal.aborted)
                    throw new AbortRun();
                while (takeoverPaused.has(taskId)) {
                    if (signal.aborted)
                        throw new AbortRun();
                    await new Promise((r) => setTimeout(r, 500));
                }
                let actionDetail = "";
                if (decision.action === "goto" && decision.url) {
                    await driver.goto(session.id, decision.url);
                    visited.push(decision.url);
                    actionDetail = `Opened ${decision.url}.`;
                }
                else if (decision.action === "act" && decision.instruction) {
                    const r = await driver.act(session.id, decision.instruction);
                    if (!r.ok)
                        throw new Error(r.detail);
                    actionDetail = r.detail;
                }
                else if (decision.action === "extract") {
                    const text = await driver.extract(session.id, decision.query ?? "");
                    actionDetail = `Read the page (${text.length} characters).`;
                }
                stepsUsed += 1;
                await getPool().query("UPDATE agent_tasks SET steps_used = $1, updated_at = now() WHERE id = $2", [stepsUsed, taskId]);
                history.push(`${decision.description} — ${actionDetail}`);
                await writeAudit(task.user_id, taskId, "browser_action", {
                    step: stepsUsed,
                    action: decision.action,
                    description: decision.description,
                    detail: actionDetail,
                });
                // Observe + guard the fresh page content.
                snapshot = await driver.snapshot(session.id);
                const wrapped = wrapUntrusted(snapshot.url, snapshot.text);
                void wrapped;
                if (containsInjectionProbe(snapshot.text)) {
                    const flag = `A page (${snapshot.url || "unknown page"}) contained text trying to give the agent new instructions. It was ignored.`;
                    if (!suspicious.includes(flag))
                        suspicious.push(flag);
                    await writeAudit(task.user_id, taskId, "suspicious_content", { url: snapshot.url });
                }
                if (driver.screenshot) {
                    try {
                        await driver.screenshot(session.id);
                        await getPool().query("UPDATE agent_tasks SET screenshots = screenshots || $1::jsonb WHERE id = $2", [JSON.stringify([{ n: stepsUsed, capturedAt: new Date().toISOString() }]), taskId]);
                    }
                    catch {
                        // screenshots are best effort
                    }
                }
            }
        }
        catch (err) {
            const t = await loadTask(taskId);
            if (!t || TERMINAL.includes(t.status))
                return;
            if (err instanceof AbortRun || signal.aborted) {
                // Cancelled via the cancel route (or the run was aborted while
                // paused/waiting): the one place terminal cancellation is written.
                await finalizeTask(taskId, { status: "cancelled", error: "The task was cancelled." }, { driver, userId: t.user_id, title: t.title, startedAt, stepsUsed: t.steps_used, llmCostUsd });
                return;
            }
            const message = err instanceof Error ? err.message : "The agent task failed.";
            await finalizeTask(taskId, { status: "failed", error: message }, {
                driver,
                userId: t.user_id,
                title: t.title,
                startedAt,
                stepsUsed: t.steps_used,
                llmCostUsd,
            });
        }
        finally {
            aborters.delete(taskId);
        }
    }
    finally {
        activeTasks.delete(taskId);
    }
}
function buildReport(task, history, visited, suspicious, summary) {
    const lines = [`# ${task.title}`, ""];
    lines.push(summary && summary.trim() ? summary.trim() : "The task was completed.");
    lines.push("", "## What was done");
    if (history.length === 0)
        lines.push("- Nothing needed doing.");
    else
        for (const h of history)
            lines.push(`- ${h}`);
    if (visited.length > 0) {
        lines.push("", "## Pages visited");
        for (const u of visited)
            lines.push(`- ${u}`);
    }
    if (suspicious.length > 0) {
        lines.push("", "## Something to know");
        for (const s of suspicious)
            lines.push(`- ${s}`);
    }
    return lines.join("\n");
}
/** Cancel a task: abort a live run, or finalize directly when idle. */
export async function cancelAgentTask(taskId, userId) {
    const task = await loadTask(taskId);
    if (!task || task.user_id !== userId || TERMINAL.includes(task.status))
        return false;
    abortAgentTask(taskId);
    if (!activeTasks.has(taskId)) {
        // No live run to finalize on abort — do it here.
        await finalizeTask(taskId, { status: "cancelled", error: "The task was cancelled." }, {
            driver: null,
            userId: task.user_id,
            title: task.title,
            startedAt: task.started_at ? new Date(task.started_at).getTime() : Date.now(),
            stepsUsed: task.steps_used,
            llmCostUsd: 0,
        });
    }
    return true;
}
/** Test/route helper: current pending approval for a task (if any). */
export async function getPendingApproval(taskId) {
    return latestPendingApproval(taskId);
}
//# sourceMappingURL=runner.js.map