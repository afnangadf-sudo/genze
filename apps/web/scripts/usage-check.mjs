// Step 5 spot-checks: usage helpers + owner-admin visibility.
//  1. New i18n keys exist in all five dictionaries (full parity is covered by i18n-check).
//  2. limitMessage / fmt / featureName / isLimitExceeded behave.
//  3. AdminView renders the "not available" note for non-owners and the
//     provider board (with env-locked toggles disabled) for owners.
//
// Run: pnpm test (in apps/web). Compiles lib/usage.ts + lib/i18n.ts +
// app/admin/AdminView.tsx to a temp dir inside apps/web (so react resolves),
// with a stubbed ./auth and @genze/shared — no network, no bundler.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const webDir = join(fileURLToPath(import.meta.url), "..", "..");
const tmp = mkdtempSync(join(webDir, ".usage-test-"));

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const NEW_KEYS = [
  "u_title", "u_plan", "u_free", "u_paid", "u_coming_soon", "u_credits",
  "u_granted_today", "u_today_cost", "u_unlimited", "u_resets",
  "u_feat_chat", "u_feat_research", "u_feat_agent", "u_feat_video", "u_feat_files",
  "u_limit_msg",
  "a_title", "a_not_available", "a_configured", "a_not_configured",
  "a_on", "a_off", "a_stopped_by", "a_by_server", "a_by_page",
  "a_regions", "a_can_do", "a_env_locked",
];

try {
  const fs = await import("node:fs");

  // Type stub for @genze/shared: everything lib/usage.ts + AdminView need.
  fs.writeFileSync(
    join(tmp, "shared-stub.d.ts"),
    `declare module "@genze/shared" {
      export type SupportedLanguage = "en" | "ur" | "ar" | "tr" | "fa";
      export type MeteredFeature = "chat" | "research" | "agent" | "video" | "files";
      export type PlanType = "free" | "paid";
      export type ProviderId = string;
      export type Capability = string;
      export interface ProviderAdminStatus {
        id: ProviderId; configured: boolean; enabled: boolean;
        killedBy: "env" | "db" | null; regions: string[]; capabilities: Capability[];
      }
      export interface FeatureUsage {
        feature: MeteredFeature; used: number; cap: number | null; resetAt: string;
      }
      export interface UsageSummary {
        plan: PlanType; day: string; features: FeatureUsage[];
        credits: { balance: number; grantedToday: number }; costUsdToday: number;
      }
      export interface ApiErrorBody { code: string; message: string; details?: Record<string, unknown>; }
      export type ApiResponse<T> = { data: T; error?: never } | { data?: never; error: ApiErrorBody };
      export const LIMIT_EXCEEDED: "LIMIT_EXCEEDED";
      export const API_ROUTES: {
        usageSummary: string; adminProviders: string;
        adminProvider: (providerId: string) => string;
        [k: string]: any;
      };
    }\n`
  );

  // Runtime stub for @genze/shared (only LIMIT_EXCEEDED is read at module load
  // by isLimitExceeded's module scope; the API clients are never called here).
  const sharedDir = join(tmp, "node_modules", "@genze", "shared");
  mkdirSync(sharedDir, { recursive: true });
  writeFileSync(
    join(sharedDir, "package.json"),
    JSON.stringify({ name: "@genze/shared", version: "0.0.0-test", main: "index.js" })
  );
  writeFileSync(
    join(sharedDir, "index.js"),
    `module.exports = {
      LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
      API_ROUTES: {
        usageSummary: "/api/v1/usage/summary",
        adminProviders: "/api/v1/admin/providers",
        adminProvider: (id) => "/api/v1/admin/providers/" + id,
      },
    };\n`
  );

  // Force CommonJS inside the temp dir: the web package.json says
  // "type": "module", which would make node treat our tsc CJS emit as ESM.
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "commonjs" }));

  execFileSync(
    "pnpm",
    [
      "exec", "tsc",
      join(webDir, "lib", "i18n.ts"),
      join(webDir, "lib", "usage.ts"),
      join(webDir, "app", "admin", "AdminView.tsx"),
      join(tmp, "shared-stub.d.ts"),
      "--outDir", tmp,
      "--module", "commonjs",
      "--target", "es2022",
      "--jsx", "react-jsx",
      "--moduleResolution", "node",
      "--skipLibCheck",
    ],
    { cwd: webDir, stdio: "pipe" }
  );

  // Overwrite the real ./auth emit with a hermetic runtime stub
  // (usage.ts only needs ApiClientError at runtime here).
  writeFileSync(
    join(tmp, "lib", "auth.js"),
    `class ApiClientError extends Error {
      constructor(code, message, status, details) {
        super(message);
        this.code = code; this.status = status;
        if (details !== undefined) this.details = details;
      }
    }
    module.exports = { ApiClientError, apiFetch: async () => { throw new Error("no network in tests"); } };\n`
  );

  const require = createRequire(join(webDir, "package.json"));
  const { STRINGS } = require(join(tmp, "lib", "i18n.js"));
  const usage = require(join(tmp, "lib", "usage.js"));
  const { ApiClientError } = require(join(tmp, "lib", "auth.js"));
  const { AdminView } = require(join(tmp, "app", "admin", "AdminView.js"));

  // 1. New keys exist in every dictionary and are non-empty.
  for (const code of Object.keys(STRINGS)) {
    const missing = NEW_KEYS.filter((k) => !(k in STRINGS[code]));
    const empty = NEW_KEYS.filter((k) => typeof STRINGS[code][k] !== "string" || STRINGS[code][k].length === 0);
    check(`step5 keys present in ${code}`, missing.length === 0, missing.join(","));
    check(`step5 keys non-empty in ${code}`, empty.length === 0, empty.join(","));
  }

  // 2a. isLimitExceeded.
  const limitErr = new ApiClientError("LIMIT_EXCEEDED", "slow down", 429, {
    feature: "chat",
    resetAt: "2026-10-19T00:00:00.000Z",
  });
  check("isLimitExceeded true on 429 LIMIT_EXCEEDED", usage.isLimitExceeded(limitErr) === true);
  check(
    "isLimitExceeded false otherwise",
    usage.isLimitExceeded(new ApiClientError("RATE_LIMITED", "x", 429)) === false &&
      usage.isLimitExceeded(new Error("boom")) === false &&
      usage.isLimitExceeded(null) === false
  );

  // 2b. fmt.
  check("fmt replaces placeholders", usage.fmt("a {x} b", { x: "1" }) === "a 1 b");
  check("fmt leaves unknown keys", usage.fmt("a {x} b", {}) === "a {x} b");

  // 2c. featureName: distinct, non-empty per feature in en.
  const names = ["chat", "research", "agent", "video", "files"].map((f) =>
    usage.featureName(STRINGS.en, f)
  );
  check("featureName distinct per feature", new Set(names).size === 5, names.join(" / "));

  // 2d. limitMessage in all five languages.
  const resetAt = "2026-10-19T00:00:00.000Z";
  const resetText = new Date(resetAt).toLocaleString();
  for (const code of Object.keys(STRINGS)) {
    const msg = usage.limitMessage(code, "chat", 50, 50, resetAt);
    check(
      `limitMessage ${code} has feature, count and reset`,
      msg.includes(usage.featureName(STRINGS[code], "chat")) &&
        msg.includes("50") &&
        msg.includes(resetText) &&
        !msg.includes("{"),
      msg
    );
  }
  const noCount = usage.limitMessage("en", "research", null, null, resetAt);
  check("limitMessage without counts reads clean", !noCount.includes("()") && !noCount.includes("{"));
  const filesMsg = usage.limitMessage("en", "files", null, 200, resetAt);
  check("limitMessage files cap shows MB", filesMsg.includes("200 MB"), filesMsg);
  check(
    "limitMessage unknown-feature fallback safe",
    typeof usage.limitMessage("en", "chat", 1, 1, "not-a-date") === "string"
  );

  // 3. AdminView visibility.
  const providers = [
    { id: "anthropic", configured: true, enabled: true, killedBy: null, regions: ["US", "GB"], capabilities: ["chat"] },
    { id: "kling", configured: false, enabled: false, killedBy: "env", regions: [], capabilities: ["video"] },
    { id: "openai", configured: true, enabled: false, killedBy: "db", regions: ["US"], capabilities: ["chat", "image"] },
  ];
  const noop = () => {};
  const denied = renderToStaticMarkup(
    React.createElement(AdminView, {
      t: STRINGS.en, isOwner: false, providers, busyId: null, onToggle: noop,
    })
  );
  check("admin hidden for non-owners", denied.includes(STRINGS.en.a_not_available));
  check(
    "admin board not leaked to non-owners",
    !denied.includes("Anthropic") && !denied.includes(STRINGS.en.s_disable)
  );

  const board = renderToStaticMarkup(
    React.createElement(AdminView, {
      t: STRINGS.en, isOwner: true, providers, busyId: null, onToggle: noop,
    })
  );
  check("admin board lists providers", board.includes("Anthropic") && board.includes("Kling"));
  check(
    "admin board shows configured state",
    board.includes(STRINGS.en.a_configured) && board.includes(STRINGS.en.a_not_configured)
  );
  check(
    "admin board shows regions + capabilities",
    board.includes("US, GB") && board.includes("chat, image")
  );
  check(
    "env-killed toggle disabled with note",
    board.includes("disabled") && board.includes(STRINGS.en.a_env_locked)
  );
  check(
    "toggle labels follow state",
    board.includes(STRINGS.en.s_disable) && board.includes(STRINGS.en.s_enable)
  );
  check(
    "killed-by source shown plainly",
    board.includes(STRINGS.en.a_by_server) && board.includes(STRINGS.en.a_by_page)
  );

  // RTL language renders the same board without crashing.
  const urdu = renderToStaticMarkup(
    React.createElement(AdminView, {
      t: STRINGS.ur, isOwner: false, providers: [], busyId: null, onToggle: noop,
    })
  );
  check("admin urdu note renders", urdu.includes(STRINGS.ur.a_not_available));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll usage checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
