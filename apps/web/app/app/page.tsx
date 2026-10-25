import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { APP_SESSION_COOKIE } from "@/lib/appSession";
import { opponentContextFromQuery } from "@/lib/opponentNavigation";
import {
  defaultTabRedirect,
  hrefForTab,
  isTabId,
  opponentDossierHref,
} from "@/components/analyzer/tabs";
import { TodayView } from "@/components/dashboard/TodayView";
import { analyzerViewHref, sanitizeAnalyzerViews, viewFiltersFromQuery } from "@/lib/analyzerViews";

export const metadata = {
  title: "Today",
  description:
    "Your session at a glance — live game, streak, MMR, and today's pulse from your own replays.",
};

/**
 * Longest the saved-view/default-tab lookup may hold the first /app page of a
 * session. Past this (a restart, an unavailable or slow API) the visit just
 * shows Today.
 */
const DEFAULT_VIEW_LOOKUP_TIMEOUT_MS = 1500;

/**
 * /app — the Today screen: the between-games glance (live game, session
 * record, streak, MMR, Daily Pulse). Every analyzer section now lives at
 * its own route under /app/, so this page also honours the two legacy
 * URL shapes that used to address in-page tab state:
 *
 *   /app?opponent=<pulseId>  → /app/opponents/<pulseId>   (dossier backlinks)
 *   /app?tab=<tabId>         → /app/<section>             (old deep links)
 *
 * On the first plain /app visit of a browser session, a default saved view
 * (or the legacy Settings default tab) opens instead of Today. The
 * redirect runs here, before render, so Today never flashes first.
 */
export default async function AppHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;

  const opponent = opponentContextFromQuery(query);
  if (opponent) redirect(opponentDossierHref(opponent.pulseId));

  const rawTab = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const urlQuery = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) { const value = Array.isArray(raw) ? raw[0] : raw; if (value !== undefined && key !== "tab") urlQuery.set(key, value); }
  if (isTabId(rawTab)) redirect(`${hrefForTab(rawTab)}${urlQuery.size ? `?${urlQuery}` : ""}`);

  const rawView = Array.isArray(query.view) ? query.view[0] : query.view;
  const target = rawView === "today" || viewFiltersFromQuery(urlQuery).present ? null : await defaultViewForThisVisit();
  if (target) redirect(target);

  return <TodayView />;
}

/**
 * The default saved-view URL, legacy section URL, or null to show Today.
 *
 * Only the first /app page of a browser session reads it: AnalyzerFrame
 * sets the session cookie (lib/appSession.ts) once any /app page has
 * mounted, so clicking Today later, or opening a bookmark such as
 * /app/maps first and then Today, always shows Today. A missing
 * preference, "today", an unknown tab, a failed or slow request: all
 * show Today.
 */
async function defaultViewForThisVisit(): Promise<string | null> {
  try {
    const jar = await cookies();
    if (jar.has(APP_SESSION_COOKIE)) return null;
    const res = await apiFetch<{ defaultTab?: string; defaultView?: unknown } | null>(
      "/v1/me/analyzer-default-view",
      { signal: AbortSignal.timeout(DEFAULT_VIEW_LOOKUP_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const view = sanitizeAnalyzerViews({ views: [res.data?.defaultView] }).views[0];
    if (view) return analyzerViewHref(view);
    const tab = defaultTabRedirect(res.data?.defaultTab);
    return tab ? hrefForTab(tab) : null;
  } catch {
    return null;
  }
}
