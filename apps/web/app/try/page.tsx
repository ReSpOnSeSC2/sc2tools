/**
 * /try — analyse StarCraft II replays in the browser, no download, no
 * account (Instant Analysis). Public: the middleware only protects the
 * listed app routes, and the marketing Header/Footer come from AppShell.
 *
 * Gated by the `NEXT_PUBLIC_INSTANT_IMPORT` rollout flag: "off" → 404,
 * "admins" → the page renders but only admins get the tool (and it is
 * kept out of search results), "all" → everyone.
 *
 * Example:
 *   NEXT_PUBLIC_INSTANT_IMPORT=all next build  →  GET /try renders <TryPage mode="all" />
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TryPage } from "@/components/instant/TryPage";
import { getInstantImportMode, type InstantImportMode } from "@/lib/instant/flag";

/**
 * Page metadata per rollout mode: none when "off" (the route is a plain
 * 404 that must not name the feature), noindex in "admins" mode.
 *
 * Example:
 *   tryMetadata("off"); // -> {}
 */
function tryMetadata(mode: InstantImportMode): Metadata {
  if (mode === "off") return {};
  return {
    title: "Analyze your replays in your browser — SC2 Tools",
    description:
      "Drop your StarCraft II replays and get an instant report — record by matchup, openers, macro and why you lost — analyzed privately in your browser. No download, no account.",
    alternates: { canonical: "/try" },
    ...(mode === "all" ? {} : { robots: { index: false, follow: false } }),
  };
}

export const metadata: Metadata = tryMetadata(getInstantImportMode());

/**
 * The /try route (see module comment).
 *
 * Example:
 *   <TryRoute />
 */
export default function TryRoute() {
  const mode = getInstantImportMode();
  if (mode === "off") notFound();
  return <TryPage mode={mode} />;
}
