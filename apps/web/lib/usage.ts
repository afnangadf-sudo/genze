// Step 5: usage-dashboard + owner-admin API clients, and the plain-language
// limit-exceeded message shared by every flow (chat, research, write, files).
// Every route comes from API_ROUTES (@genze/shared) — never hardcoded.

import {
  API_ROUTES,
  LIMIT_EXCEEDED,
  type MeteredFeature,
  type ProviderAdminStatus,
  type UsageSummary,
} from "@genze/shared";
import { ApiClientError, apiFetch } from "./auth";
import { STRINGS, type Lang, type Strings } from "./i18n";

/* ---------- API clients ---------- */

/** Today's usage for the signed-in user. */
export async function getUsageSummary(): Promise<UsageSummary> {
  return apiFetch<UsageSummary>(API_ROUTES.usageSummary);
}

/** Provider kill-switch board (owner only — 403 otherwise). */
export async function getProviderAdmin(): Promise<ProviderAdminStatus[]> {
  const data = await apiFetch<{ providers: ProviderAdminStatus[] }>(API_ROUTES.adminProviders);
  return data.providers;
}

/** Flip one provider's DB kill switch (owner only). */
export async function setProviderKilled(
  providerId: string,
  killed: boolean
): Promise<ProviderAdminStatus> {
  const data = await apiFetch<{ provider: ProviderAdminStatus }>(
    API_ROUTES.adminProvider(providerId),
    { method: "PATCH", body: JSON.stringify({ killed }) }
  );
  return data.provider;
}

/* ---------- feature names ---------- */

export function isMeteredFeature(v: unknown): v is MeteredFeature {
  return v === "chat" || v === "research" || v === "agent" || v === "video" || v === "files";
}

/** Plain feature name in the UI language. */
export function featureName(t: Strings, feature: MeteredFeature): string {
  switch (feature) {
    case "chat":
      return t.u_feat_chat;
    case "research":
      return t.u_feat_research;
    case "agent":
      return t.u_feat_agent;
    case "video":
      return t.u_feat_video;
    case "files":
      return t.u_feat_files;
  }
}

/* ---------- limit-exceeded UX ---------- */

/** True when the error is a 429 LIMIT_EXCEEDED from the API. */
export function isLimitExceeded(err: unknown): err is ApiClientError {
  return err instanceof ApiClientError && err.code === LIMIT_EXCEEDED;
}

/** Replaces {key} placeholders; unknown keys are left untouched. Pure. */
export function fmt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m
  );
}

/**
 * Plain-language "you've hit today's limit" message, with the reset time in
 * plain words. `used`/`cap` are shown when the caller knows them — the API's
 * 429 details only carry { feature, resetAt }, so callers usually pass nulls
 * and the message reads fine without numbers.
 */
export function limitMessage(
  lang: Lang,
  feature: MeteredFeature,
  used: number | null,
  cap: number | null,
  resetAt: string
): string {
  const t = STRINGS[lang];
  const count = used ?? cap;
  const countText = count === null ? "" : ` (${count}${feature === "files" ? " MB" : ""})`;
  let reset = resetAt;
  try {
    if (resetAt) reset = new Date(resetAt).toLocaleString();
  } catch {
    /* keep the raw value */
  }
  return fmt(t.u_limit_msg, {
    feature: featureName(t, feature),
    cap: countText,
    reset,
  });
}

/**
 * Drop-in replacement for the usual `err instanceof ApiClientError ?
 * err.message : t.err_generic`: renders the limit message when the error is
 * a 429 LIMIT_EXCEEDED, otherwise the API's plain message or the generic one.
 */
export function friendlyErrText(lang: Lang, t: Strings, err: unknown): string {
  if (isLimitExceeded(err)) {
    const d = err.details ?? {};
    const feature = isMeteredFeature(d.feature) ? d.feature : "chat";
    const resetAt = typeof d.resetAt === "string" ? d.resetAt : "";
    return limitMessage(lang, feature, null, null, resetAt);
  }
  return err instanceof ApiClientError ? err.message : t.err_generic;
}
