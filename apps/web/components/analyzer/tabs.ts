import type { ComponentType, SVGProps } from "react";
import {
  ArcadeIcon,
  BuildsIcon,
  MacroIcon,
  MapsIcon,
  OpponentsIcon,
  ReplaysIcon,
  StrategiesIcon,
  TrendsIcon,
} from "./icons/NavIcons";

export type TabId =
  | "replays"
  | "opponents"
  | "strategies"
  | "trends"
  | "macro"
  | "battlefield"
  | "builds"
  | "arcade";

export type NavIconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export type TabDef = {
  id: TabId;
  label: string;
  icon: NavIconComponent;
  description?: string;
};

export const TABS: readonly TabDef[] = [
  { id: "opponents", label: "Opponents", icon: OpponentsIcon, description: "Drill into the players you've faced." },
  { id: "strategies", label: "Strategies", icon: StrategiesIcon, description: "Build vs strategy and per-strategy results." },
  { id: "trends", label: "Trends", icon: TrendsIcon, description: "Win-rate trajectory across periods." },
  { id: "macro", label: "Macro", icon: MacroIcon, description: "Your macro report: leaks priced in minerals, and where macro wins games." },
  { id: "battlefield", label: "Maps", icon: MapsIcon, description: "Maps and matchup performance." },
  { id: "builds", label: "Build stats", icon: BuildsIcon, description: "Win rates and trends for the builds you play." },
  { id: "replays", label: "Replays", icon: ReplaysIcon, description: "Browse, filter, and share your replay history." },
  { id: "arcade", label: "Arcade", icon: ArcadeIcon, description: "Quizzes and games that go deeper than the charts." },
] as const;

/* ------------------------------------------------------------------
 * Routed sections.
 *
 * Every analyzer section is a real URL under /app. The slug is the
 * public path segment; it matches the tab id except for "battlefield",
 * which has always been labelled Maps in the UI and therefore lives at
 * /app/maps. TabId itself is unchanged so persisted preferences (the
 * Settings "default tab" picker writes TabIds) keep working.
 * ------------------------------------------------------------------ */

export type SectionSlug =
  | "replays"
  | "opponents"
  | "strategies"
  | "trends"
  | "macro"
  | "maps"
  | "builds"
  | "arcade";

const TAB_TO_SLUG: Record<TabId, SectionSlug> = {
  replays: "replays",
  opponents: "opponents",
  strategies: "strategies",
  trends: "trends",
  macro: "macro",
  battlefield: "maps",
  builds: "builds",
  arcade: "arcade",
};

const SLUG_TO_TAB: Record<SectionSlug, TabId> = {
  replays: "replays",
  opponents: "opponents",
  strategies: "strategies",
  trends: "trends",
  macro: "macro",
  maps: "battlefield",
  builds: "builds",
  arcade: "arcade",
};

export function isTabId(value: string | null | undefined): value is TabId {
  return TABS.some((t) => t.id === value);
}

/**
 * The Settings "Default tab" value for staying on Today (/app). It is
 * not a TabId: Today is the landing page, not a routed section.
 */
export const TODAY_DEFAULT_TAB = "today";

/**
 * The section a saved "Default tab" preference sends Today to, or null
 * to stay on Today (no choice, "today", or a tab that no longer exists).
 * The Settings picker saves TabIds; a section's URL slug ("maps") is
 * read as its tab too.
 *
 * Example:
 *   defaultTabRedirect("battlefield"); // -> "battlefield"
 *   defaultTabRedirect("maps"); // -> "battlefield"
 *   defaultTabRedirect("today"); // -> null
 */
export function defaultTabRedirect(pref: string | null | undefined): TabId | null {
  if (!pref || pref === TODAY_DEFAULT_TAB) return null;
  if (isTabId(pref)) return pref;
  return tabForSlug(pref)?.id ?? null;
}

export function slugForTab(id: TabId): SectionSlug {
  return TAB_TO_SLUG[id];
}

/** Resolve a URL segment to its tab definition; null for unknown slugs. */
export function tabForSlug(slug: string): TabDef | null {
  const id = SLUG_TO_TAB[slug as SectionSlug];
  if (!id) return null;
  return TABS.find((t) => t.id === id) ?? null;
}

/** Canonical route for a section, e.g. hrefForTab("battlefield") → "/app/maps". */
export function hrefForTab(id: TabId): string {
  return `/app/${TAB_TO_SLUG[id]}`;
}

/** Canonical route for one opponent's dossier. */
export function opponentDossierHref(pulseId: string): string {
  return `/app/opponents/${encodeURIComponent(pulseId)}`;
}
