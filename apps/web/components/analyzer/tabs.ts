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
  { id: "replays", label: "Replays", icon: ReplaysIcon, description: "Browse, filter, and share your replay history." },
  { id: "opponents", label: "Opponents", icon: OpponentsIcon, description: "Drill into the players you've faced." },
  { id: "strategies", label: "Strategies", icon: StrategiesIcon, description: "Build vs strategy and per-strategy results." },
  { id: "trends", label: "Trends", icon: TrendsIcon, description: "Win-rate trajectory across periods." },
  { id: "macro", label: "Macro", icon: MacroIcon, description: "Your macro report: leaks priced in minerals, and where macro wins games." },
  { id: "battlefield", label: "Maps", icon: MapsIcon, description: "Maps and matchup performance." },
  { id: "builds", label: "Builds", icon: BuildsIcon, description: "Your builds, performance, and editor." },
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
