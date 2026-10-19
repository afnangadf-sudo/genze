// Fact-check background runner (in-process, like the research runner —
// decision #42). Extracts checkable claims from a draft, searches + fetches
// supporting pages per claim, and asks the routed chat provider for a
// verdict: supported | disputed | unverified, with source links.
// An "unverified" verdict is an honest result, not a failure — only hard
// errors (no provider, no pages at all, extraction failure) fail the job.

import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { pickSearchProvider } from "../search/index.js";
import { completeWithProvider } from "../providers/complete.js";
import type { ChatProvider } from "../providers/chatProvider.js";
import { makeChatProvider } from "../providers/instances.js";
import { chatReplyCost, routeChat, type ModelInfo } from "../providers/models.js";
import { getUserCountry, hasLiveConsent } from "../users.js";
import { fetchPage, type FetchedPage } from "../research/fetch.js";
import { recordUsage } from "../usage.js";

export type FactCheckStatus = "planned" | "running" | "done" | "failed" | "cancelled";

export interface DbFactCheck {
  id: string;
  user_id: string;
  draft_id: string;
  thread_id: string | null;
  status: FactCheckStatus;
  claims: Array<{
    claim: string;
    verdict: "supported" | "disputed" | "unverified";
    sources: Array<{ n: number; url: string; title: string }>;
  }>;
  created_at: Date;
  updated_at: Date;
}

export function newFactCheckId(): string {
  return uuidv4();
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : def;
}

const MAX_CLAIMS = 10;
const PAGES_PER_CLAIM = 3;

const CLAIMS_SYSTEM =
  "You are a fact-check assistant extracting checkable claims. " +
  "List the concrete factual claims in the text that could be verified " +
  "against web sources (dates, numbers, names, events, causal statements). " +
  "Skip opinions, advice, and stylistic flourishes. " +
  "Reply with ONLY a JSON array of claim strings, e.g. [\"claim one\", \"claim two\"].";

const VERIFY_SYSTEM =
  "You are a fact-check assistant verifying a claim. Given the claim and " +
  "excerpts from web pages, decide:\n" +
  "- supported: a source clearly confirms the claim\n" +
  "- disputed: a source contradicts the claim\n" +
  "- unverified: no source confirms or denies it\n" +
  "Reply with ONLY JSON: {\"verdict\": \"supported\"|\"disputed\"|\"unverified\", " +
  "\"sources\": [1, 2]} where the numbers refer to the numbered excerpts. " +
  "Never invent a source.";

interface TokenTally {
  input: number;
  output: number;
}

const activeChecks = new Set<string>();
const aborters = new Map<string, AbortController>();

export function enqueueFactCheck(id: string): void {
  setImmediate(() => {
    void runFactCheck(id);
  });
}

export function abortFactCheck(id: string): void {
  aborters.get(id)?.abort();
}

async function loadCheck(id: string): Promise<DbFactCheck | null> {
  const r = await getPool().query<DbFactCheck>("SELECT * FROM fact_checks WHERE id = $1", [id]);
  return r.rowCount ? r.rows[0] : null;
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

function extractJson(text: string): unknown | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // fall through
  }
  const startArr = t.indexOf("[");
  const startObj = t.indexOf("{");
  let start = -1;
  let endChar = "";
  if (startArr !== -1 && (startObj === -1 || startArr < startObj)) {
    start = startArr;
    endChar = "]";
  } else if (startObj !== -1) {
    start = startObj;
    endChar = "}";
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

async function failCheck(id: string, userId: string, message: string): Promise<void> {
  await getPool().query(
    "UPDATE fact_checks SET status = 'failed', updated_at = now() WHERE id = $1",
    [id],
  );
  // A failed fact-check still records what it spent (record only).
  await recordUsage({
    userId,
    feature: "fact-check",
    provider: null,
    units: 0,
    costUsd: null,
    details: { outcome: "failed", error: message },
  }).catch(() => undefined);
}

export async function runFactCheck(id: string): Promise<void> {
  if (activeChecks.has(id)) return;
  activeChecks.add(id);
  try {
    const check = await loadCheck(id);
    if (!check || check.status === "done" || check.status === "failed" || check.status === "cancelled") {
      return;
    }
    const draft = await getPool().query<{ content: string; user_id: string }>(
      "SELECT content, user_id FROM write_drafts WHERE id = $1",
      [check.draft_id],
    );
    if (!draft.rowCount) {
      await failCheck(id, check.user_id, "The draft for this fact-check no longer exists.");
      return;
    }
    const searchProvider = pickSearchProvider();
    if (!searchProvider) {
      await failCheck(id, check.user_id, "Web search is not set up.");
      return;
    }
    // The route verified routing + consent at creation; re-resolve the
    // provider lazily here (same gates, fail-closed).
    const country = (await getUserCountry(check.user_id)) ?? "";
    const route = routeChat({ country, taskType: "long-context" });
    if (!route) {
      await failCheck(id, check.user_id, "No provider is available for fact-checking right now.");
      return;
    }
    // Consent was verified at creation for this user; re-check it so a
    // revocation mid-run stops new provider calls.
    if (!(await hasLiveConsent(check.user_id, route.provider))) {
      await failCheck(id, check.user_id, "Consent for the provider was withdrawn.");
      return;
    }
    const model: ModelInfo | null = route.model;
    const provider = makeChatProvider(route.provider as "anthropic" | "openai", model.id);

    await getPool().query("UPDATE fact_checks SET status = 'running', updated_at = now() WHERE id = $1", [id]);
    const aborter = new AbortController();
    aborters.set(id, aborter);
    const signal = aborter.signal;
    const tally: TokenTally = { input: 0, output: 0 };

    try {
      // 1. Extract checkable claims.
      const content = draft.rows[0].content.slice(0, 20_000);
      let claimsRaw = extractJson(
        await complete(provider, CLAIMS_SYSTEM, `Text to check:\n\n${content}`, signal, tally),
      );
      if (!Array.isArray(claimsRaw)) {
        claimsRaw = extractJson(
          await complete(
            provider,
            CLAIMS_SYSTEM,
            "Your previous reply was not a valid JSON array. Return ONLY the JSON array.\n\n" +
              `Text to check:\n\n${content}`,
            signal,
            tally,
          ),
        );
      }
      if (!Array.isArray(claimsRaw)) {
        throw new Error("The claims in this draft could not be extracted. Please try again.");
      }
      const claims = claimsRaw
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
        .slice(0, MAX_CLAIMS);

      // 2. Verify each claim: search → fetch → verdict.
      const results: DbFactCheck["claims"] = [];
      for (const claim of claims) {
        if (signal.aborted) return;
        let verdict: "supported" | "disputed" | "unverified" = "unverified";
        let sources: Array<{ n: number; url: string; title: string }> = [];
        try {
          const hits = await searchProvider.search(claim, { maxResults: PAGES_PER_CLAIM });
          const pages: FetchedPage[] = [];
          for (const h of hits.slice(0, PAGES_PER_CLAIM)) {
            if (signal.aborted) return;
            try {
              pages.push(await fetchPage(h.url));
            } catch {
              // skip unreadable pages
            }
          }
          if (pages.length > 0) {
            const excerpts = pages
              .map((p, i) => `[${i + 1}] ${p.title}\n${p.url}\n${p.text.slice(0, 2000)}`)
              .join("\n\n---\n\n");
            const v = extractJson(
              await complete(
                provider,
                VERIFY_SYSTEM,
                `Claim: ${claim}\n\nExcerpts:\n\n${excerpts}`,
                signal,
                tally,
              ),
            ) as { verdict?: unknown; sources?: unknown } | null;
            const vv = v?.verdict;
            if (vv === "supported" || vv === "disputed" || vv === "unverified") verdict = vv;
            const nums = Array.isArray(v?.sources)
              ? (v?.sources as unknown[]).filter((n): n is number => Number.isInteger(n))
              : [];
            sources = nums
              .filter((n) => n >= 1 && n <= pages.length)
              .map((n) => ({ n, url: pages[n - 1].url, title: pages[n - 1].title }));
          }
        } catch {
          // Any per-claim failure degrades to "unverified", never a fake verdict.
        }
        results.push({ claim, verdict, sources });
      }

      await getPool().query(
        "UPDATE fact_checks SET status = 'done', claims = $1::jsonb, updated_at = now() WHERE id = $2",
        [JSON.stringify(results), id],
      );
      const cost = chatReplyCost(model, tally.input, tally.output);
      await recordUsage({
        userId: check.user_id,
        feature: "fact-check",
        provider: route.provider,
        units: tally.input + tally.output,
        costUsd: cost,
        details: { claims: results.length, outcome: "done" },
      });
    } catch (err) {
      if (signal.aborted) return;
      const message = err instanceof Error ? err.message : "Fact-check failed.";
      await failCheck(id, check.user_id, message);
    } finally {
      aborters.delete(id);
    }
  } finally {
    activeChecks.delete(id);
  }
}
