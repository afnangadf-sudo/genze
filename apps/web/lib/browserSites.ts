// Browser-sites API client: websites Genze reaches through its own browser
// (no API, no MCP server). Every route comes from API_ROUTES (@genze/shared).

import {
  API_ROUTES,
  type BrowserSite,
  type BrowserLoginSession,
  type BrowserSessionDetection,
  type BrowserSiteStatus,
} from "@genze/shared";
import { apiFetch } from "./auth";

export type { BrowserSite, BrowserSiteStatus, BrowserSessionDetection };

export async function listBrowserSites(): Promise<BrowserSite[]> {
  const data = await apiFetch<{ sites: BrowserSite[] }>(API_ROUTES.browserSites);
  return data.sites;
}

export async function addBrowserSite(name: string, url: string): Promise<BrowserSite> {
  const data = await apiFetch<{ site: BrowserSite }>(API_ROUTES.browserSites, {
    method: "POST",
    body: JSON.stringify({ name, url }),
  });
  return data.site;
}

export async function beginSiteLogin(siteId: string): Promise<BrowserLoginSession> {
  return apiFetch<BrowserLoginSession>(API_ROUTES.browserSiteLogin(siteId), { method: "POST" });
}

export async function completeSiteLogin(
  siteId: string,
  loginSessionId: string,
): Promise<{ status: BrowserSiteStatus; detection: BrowserSessionDetection }> {
  return apiFetch(API_ROUTES.browserSiteLoginComplete(siteId), {
    method: "POST",
    body: JSON.stringify({ loginSessionId }),
  });
}

export async function checkSiteLogin(
  siteId: string,
): Promise<{ status: BrowserSiteStatus; detection: BrowserSessionDetection }> {
  return apiFetch(API_ROUTES.browserSiteCheck(siteId), { method: "POST" });
}

export async function disconnectBrowserSite(siteId: string): Promise<void> {
  await apiFetch(API_ROUTES.browserSite(siteId), { method: "DELETE" });
}
