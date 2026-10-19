// Research job runner: in-process background execution (per CONTRACTS.md
// Step 4 and decision #42 — no BullMQ in v1; the DB row is the source of
// truth). `enqueueResearchJob` is the swappable seam: today it
// setImmediate-starts runResearchJob in this process; tomorrow it can push to
// a real queue without the routes changing.
//
// Phases (progress {phase, done, total, message} updated at each step):
//   plan       — 3–6 steps via the chat router, at creation, before `start`
//   search     — query variants via the router, parallel provider searches
//   fetch      — open the best pages (robots/timeouts/caps honored)
//   synthesize — cited report via the router + validateCitations (+1 retry)
// Terminal states write status + updated_at. A boot sweep marks stale
// `running` jobs failed. One routed provider per job (stored in
// progress.provider/model at creation); no demo research, ever.

import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { pickSearchProvider, type SearchResult } from "../search/index.js";
import { completeWithProvider } from "../providers/complete.js";
import type { ChatProvider } from "../providers/chatProvider.js";
import { makeChatProvider } from "../providers/instances.js";
import { chatReplyCost, findChatModel, type ModelInfo } from "../providers/models.js";
import { fetchPage, type FetchedPage } from "./fetch.js";
import { validateCitations } from "./citations.js";
import { recordUsage } from "../usage.js";

export type ResearchStatus = "planned" | "running" | "done" | "failed" | "cancelled";

export interface JobProgress {
  phase: string;
  done: number;
  total: number;
  message?: string;
  /** Routed provider id + model id, stored at creation (internal). */
  provider?: string;
  model?: string;
}

export interface DbResearchJob {
  id: string;
  user_id: string;
  thread_id: string | null;
  topic: string;
  status: ResearchStatus;
  plan: { steps: string[] } | null;
  progress: JobProgress;
  report_markdown: string | null;
  sources: Array<{ n: number; url: string; title: string; fetchedAt: string }>;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : def;
}

export function researchMaxSearches(): number {
  return envInt("RESEARCH_MAX_SEARCHES", 6);
}

export function researchMaxSources(): number {
  return envInt("RESEARCH_MAX_SOURCES", 8);
}

/** Per-page excerpt chars fed to the synthesis prompt (bounds cost). */
export function synthSourceChars(): number {
  return envInt("RESEARCH_SYNTH_CHARS", 4000);
}

/* ---------- job registry (cancellation + re-entrancy) ---------- */

const activeJobs = new Set<string>();
const aborters = new Map<string, AbortController>();

/** The swappable enqueue seam: today, run in this process. */
export function enqueueResearchJob(jobId: string): void {
  setImmediate(() => {
    void runResearchJob(jobId);
  });
}

/** Abort a live run (DELETE cancels the run, then deletes the row). */
export function abortResearchJob(jobId: string): void {
  aborters.get(jobId)?.abort();
}

export async function deleteResearchJob(userId: string, jobId: string): Promise<boolean> {
  abortResearchJob(jobId);
  const r = await getPool().query("DELETE FROM research_jobs WHERE id = $1 AND user_id = $2", [
    jobId,
    userId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

/** Boot sweep: jobs stuck in `running` (e.g. the process died) fail honestly. */
export async function sweepStaleJobs(): Promise<number> {
  const r1 = await getPool().query(
    `UPDATE research_jobs SET status = 'failed',
       error = 'The server restarted while this research was running. Please start it again.',
       progress = progress || '{"phase":"error"}'::jsonb, updated_at = now()
     WHERE status = 'running'`,
  );
  const r2 = await getPool().query(
    `UPDATE fact_checks SET status = 'failed', updated_at = now() WHERE status = 'running'`,
  );
  return (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
}

/* ---------- small helpers ---------- */

async function loadJob(jobId: string): Promise<DbResearchJob | null> {
  const r = await getPool().query<DbResearchJob>("SELECT * FROM research_jobs WHERE id = $1", [
    jobId,
  ]);
  return r.rowCount ? r.rows[0] : null;
}

async function setProgress(jobId: string, patch: Partial<JobProgress>): Promise<void> {
  await getPool().query(
    "UPDATE research_jobs SET progress = progress || $1::jsonb, updated_at = now() WHERE id = $2",
    [JSON.stringify(patch), jobId],
  );
}

interface TokenTally {
  input: number;
  output: number;
}

async function complete(
  provider: ChatProvider,
  system: string,
  userContent: string,
  signal: AbortSignal,
  tally: TokenTally,
): Promise<string> {
  const r = await completeWithProvider(provider, {
    system,
    messages: [{ role: "user", content: userContent }],
    signal,
  });
  tally.input += r.inputTokens;
  tally.output += r.outputTokens;
  return r.text;
}

/** Extract a JSON value from model text (tolerates surrounding prose). */
function extractJson(text: string): unknown | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // fall through
  }
  const startObj = t.indexOf("{");
  const startArr = t.indexOf("[");
  let start = -1;
  let endChar = "";
  if (startObj !== -1 && (startArr === -1 || startObj < startArr)) {
    start = startObj;
    endChar = "}";
  } else if (startArr !== -1) {
    start = startArr;
    endChar = "]";
  }
  if (start === -1) return null;
  const end = t.lastIndexOf(endChar);
  if (end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseSteps(text: string): string[] | null {
  const v = extractJson(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const steps = (v as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return null;
  const clean = steps
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 6);
  return clean.length >= 3 ? clean : null;
}

function parseStringArray(text: string, max: number): string[] | null {
  const v = extractJson(text);
  if (!Array.isArray(v)) return null;
  const clean = v
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, max);
  return clean;
}

async function meterJob(
  job: DbResearchJob,
  providerId: string,
  model: ModelInfo | null,
  tally: TokenTally,
  details: Record<string, unknown>,
): Promise<void> {
  const cost = model ? chatReplyCost(model, tally.input, tally.output) : null;
  await recordUsage({
    userId: job.user_id,
    feature: "research",
    provider: providerId,
    units: tally.input + tally.output,
    costUsd: cost,
    details,
  });
}

async function failJob(
  job: DbResearchJob,
  providerId: string,
  model: ModelInfo | null,
  tally: TokenTally,
  message: string,
  details: Record<string, unknown>,
): Promise<void> {
  // Progress first, then the terminal status (same ordering guarantee as done).
  await setProgress(job.id, { phase: "error", done: 100, message });
  await getPool().query(
    "UPDATE research_jobs SET status = 'failed', error = $1, updated_at = now() WHERE id = $2",
    [message, job.id],
  );
  await meterJob(job, providerId, model, tally, { ...details, outcome: "failed" });
}

/* ---------- prompts ---------- */

const PLAN_SYSTEM =
  "You are a research planner. Break the user's topic into concrete, " +
  "answerable research steps. Reply with JSON only.";

const QUERIES_SYSTEM =
  "You are a search query generator. Turn a research topic and plan into " +
  "short, effective web search queries. Reply with a JSON array of strings only.";

const SYNTH_SYSTEM =
  "You are a research analyst writing a cited report.\n" +
  "Rules:\n" +
  "- Every factual claim must carry a citation [n] matching the numbered source list below.\n" +
  "- Anything not supported by one of the opened pages must be labeled **unverified**.\n" +
  "- Never invent a source, URL, or quote.\n" +
  "- Structure the report with EXACTLY these five sections, in this order:\n" +
  "## Summary\n" +
  "## Key findings\n" +
  "## Where sources disagree\n" +
  "## Open questions\n" +
  "## Sources\n" +
  "- The ## Sources section is a numbered list matching the sources given.";

function normalizeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    let s = parsed.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

/* ---------- phases ---------- */

async function planPhase(
  job: DbResearchJob,
  provider: ChatProvider,
  signal: AbortSignal,
  tally: TokenTally,
): Promise<string[]> {
  await setProgress(job.id, { phase: "plan", done: 5, message: "Planning the research…" });
  const user =
    `Research topic: ${job.topic}\n\n` +
    `Return ONLY a JSON object like {"steps": ["...", "...", "..."]} ` +
    `with 3 to 6 concrete research steps. No other text.`;
  let text = await complete(provider, PLAN_SYSTEM, user, signal, tally);
  let steps = parseSteps(text);
  if (!steps) {
    text = await complete(
      provider,
      PLAN_SYSTEM,
      "Your previous reply was not valid JSON. Return ONLY the JSON object, nothing else.\n\n" + user,
      signal,
      tally,
    );
    steps = parseSteps(text);
  }
  if (!steps) {
    throw new Error("The research plan could not be generated. Please try again.");
  }
  await getPool().query("UPDATE research_jobs SET plan = $1, updated_at = now() WHERE id = $2", [
    JSON.stringify({ steps }),
    job.id,
  ]);
  await setProgress(job.id, { phase: "plan", done: 15, message: "Plan ready." });
  return steps;
}

async function searchPhase(
  job: DbResearchJob,
  steps: string[],
  signal: AbortSignal,
  tally: TokenTally,
  provider: ChatProvider,
): Promise<{ results: SearchResult[]; queries: number }> {
  await setProgress(job.id, { phase: "search", done: 20, message: "Preparing search queries…" });
  const maxSearches = researchMaxSearches();
  const searchProvider = pickSearchProvider();
  if (!searchProvider) {
    throw new Error("Web search is not set up, so the research cannot continue.");
  }
  const user =
    `Topic: ${job.topic}\nPlan:\n${steps.map((s) => `- ${s}`).join("\n")}\n\n` +
    `Return ONLY a JSON array of up to ${maxSearches} short web search queries, ` +
    `e.g. ["query one", "query two"]. No other text.`;
  let queries = parseStringArray(await complete(provider, QUERIES_SYSTEM, user, signal, tally), maxSearches);
  if (!queries || queries.length === 0) {
    const retry = parseStringArray(
      await complete(
        provider,
        QUERIES_SYSTEM,
        "Your previous reply was not a valid JSON array. Return ONLY the JSON array.\n\n" + user,
        signal,
        tally,
      ),
      maxSearches,
    );
    queries = retry && retry.length > 0 ? retry : [job.topic];
  }

  await setProgress(job.id, {
    phase: "search",
    done: 25,
    message: `Searching the web (${queries.length} quer${queries.length === 1 ? "y" : "ies"})…`,
  });
  const batches = await Promise.all(
    queries.map((q) => searchProvider.search(q, { maxResults: 5 }).catch(() => [] as SearchResult[])),
  );
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const batch of batches) {
    for (const r of batch) {
      const key = normalizeUrl(r.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }
  }
  await setProgress(job.id, {
    phase: "search",
    done: 35,
    message: `Found ${deduped.length} pages to consider.`,
  });
  return { results: deduped, queries: queries.length };
}

async function fetchPhase(
  job: DbResearchJob,
  results: SearchResult[],
  signal: AbortSignal,
): Promise<{ pages: FetchedPage[]; skipped: number }> {
  const maxSources = researchMaxSources();
  const targets = results.slice(0, maxSources);
  const pages: FetchedPage[] = [];
  let skipped = 0;
  let i = 0;
  for (const t of targets) {
    if (signal.aborted) throw new Error("aborted");
    i += 1;
    await setProgress(job.id, {
      phase: "fetch",
      done: 35 + Math.round((25 * i) / Math.max(targets.length, 1)),
      message: `Opening page ${i} of ${targets.length}…`,
    });
    try {
      pages.push(await fetchPage(t.url));
    } catch {
      skipped += 1; // skipped, never fatal — unless nothing opened at all
    }
  }
  if (pages.length === 0) {
    throw new Error(
      "No pages could be opened for this topic. The sites may be unreachable or blocking automated reads.",
    );
  }
  const sources = pages.map((p, idx) => ({
    n: idx + 1,
    url: p.url,
    title: p.title,
    fetchedAt: p.fetchedAt,
  }));
  await getPool().query("UPDATE research_jobs SET sources = $1::jsonb, updated_at = now() WHERE id = $2", [
    JSON.stringify(sources),
    job.id,
  ]);
  await setProgress(job.id, {
    phase: "fetch",
    done: 60,
    message: `Opened ${pages.length} page${pages.length === 1 ? "" : "s"}.`,
  });
  return { pages, skipped };
}

async function synthesizePhase(
  job: DbResearchJob,
  steps: string[],
  pages: FetchedPage[],
  provider: ChatProvider,
  signal: AbortSignal,
  tally: TokenTally,
): Promise<string> {
  await setProgress(job.id, { phase: "synthesize", done: 70, message: "Writing the report…" });
  const perPage = synthSourceChars();
  const sourceBlocks = pages
    .map((p, i) => `[${i + 1}] ${p.title}\n${p.url}\n${p.text.slice(0, perPage)}`)
    .join("\n\n---\n\n");
  const user =
    `Research topic: ${job.topic}\n\n` +
    `Research plan:\n${steps.map((s) => `- ${s}`).join("\n")}\n\n` +
    `Sources (cite claims as [n]):\n\n${sourceBlocks}\n\n` +
    `Write the report now.`;
  let text = await complete(provider, SYNTH_SYSTEM, user, signal, tally);
  let check = validateCitations(text, pages.length);
  if (!check.ok) {
    const correction =
      `Your previous draft had these problems:\n- ${check.errors.join("\n- ")}\n\n` +
      `Fix every problem and return the FULL corrected report.`;
    text = await complete(provider, SYNTH_SYSTEM, correction, signal, tally);
    check = validateCitations(text, pages.length);
  }
  if (!check.ok) {
    throw new Error("The report did not meet the citation requirements. Please try again.");
  }
  return text;
}

/* ---------- entry point ---------- */

export async function runResearchJob(jobId: string): Promise<void> {
  if (activeJobs.has(jobId)) return; // a run is already in flight
  activeJobs.add(jobId);
  try {
    let job = await loadJob(jobId);
    if (!job || job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      return;
    }
    const providerId = job.progress.provider as "anthropic" | "openai" | undefined;
    const modelId = job.progress.model as string | undefined;
    const model: ModelInfo | null = modelId ? (findChatModel(modelId) ?? null) : null;
    if (!providerId || !modelId) {
      await failJob(job, "unknown", null, { input: 0, output: 0 }, "The job lost its provider routing. Please create it again.", {});
      return;
    }
    const provider = makeChatProvider(providerId, modelId);
    const aborter = new AbortController();
    aborters.set(jobId, aborter);
    const signal = aborter.signal;
    const tally: TokenTally = { input: 0, output: 0 };
    const stats: Record<string, unknown> = {};
    try {
      let steps = job.plan?.steps ?? null;
      if (!steps) {
        steps = await planPhase(job, provider, signal, tally);
        stats.planSteps = steps.length;
        job = (await loadJob(jobId)) ?? job;
      } else {
        stats.planSteps = steps.length;
      }
      if (job.status === "planned") {
        // Plan-confirmation gate (decision #47): the user starts when ready.
        await setProgress(job.id, {
          phase: "awaiting-start",
          done: 15,
          message: "Plan ready. Start the research when ready.",
        });
        return;
      }
      if (signal.aborted) return;
      const { results, queries } = await searchPhase(job, steps, signal, tally, provider);
      stats.queries = queries;
      stats.resultsFound = results.length;
      if (signal.aborted) return;
      const { pages, skipped } = await fetchPhase(job, results, signal);
      stats.pagesFetched = pages.length;
      stats.pagesSkipped = skipped;
      if (signal.aborted) return;
      const report = await synthesizePhase(job, steps, pages, provider, signal, tally);
      stats.citationsOk = true;

      // Progress first, then the terminal status: observers that see
      // status='done' always see the matching progress phase too.
      await setProgress(job.id, { phase: "done", done: 100, message: "Research complete." });
      await getPool().query(
        "UPDATE research_jobs SET status = 'done', report_markdown = $1, updated_at = now() WHERE id = $2",
        [report, job.id],
      );
      await meterJob(job, providerId, model, tally, { ...stats, outcome: "done" });
    } catch (err) {
      if (signal.aborted) return; // cancelled/deleted — the row is gone
      const message = err instanceof Error ? err.message : "Research failed.";
      const fresh = (await loadJob(jobId)) ?? job;
      await failJob(fresh, providerId, model, tally, message, stats);
    } finally {
      aborters.delete(jobId);
    }
  } finally {
    activeJobs.delete(jobId);
  }
}

/** Create a fresh job id (routes use this so the row exists before enqueue). */
export function newJobId(): string {
  return uuidv4();
}
