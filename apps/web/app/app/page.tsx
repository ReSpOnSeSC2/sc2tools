import { redirect } from "next/navigation";
import { opponentContextFromQuery } from "@/lib/opponentNavigation";
import {
  hrefForTab,
  isTabId,
  opponentDossierHref,
} from "@/components/analyzer/tabs";
import { TodayView } from "@/components/dashboard/TodayView";

export const metadata = {
  title: "Today · SC2 Tools",
  description:
    "Your session at a glance — live game, streak, MMR, and today's pulse from your own replays.",
};

/**
 * /app — the Today screen: the between-games glance (live game, session
 * record, streak, MMR, Daily Pulse). Every analyzer section now lives at
 * its own route under /app/, so this page also honours the two legacy
 * URL shapes that used to address in-page tab state:
 *
 *   /app?opponent=<pulseId>  → /app/opponents/<pulseId>   (dossier backlinks)
 *   /app?tab=<tabId>         → /app/<section>             (old deep links)
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
  if (isTabId(rawTab)) redirect(hrefForTab(rawTab));

  return <TodayView />;
}
