import type { HelpCategoryId } from "./types";

/**
 * Help topics in display order. The hub, Settings → Help and the
 * breadcrumbs all read this list; a topic with no articles yet is
 * simply not shown.
 */
export interface HelpCategory {
  id: HelpCategoryId;
  name: string;
  description: string;
}

export const HELP_CATEGORIES: readonly HelpCategory[] = [
  {
    id: "getting-started",
    name: "Getting started",
    description: "Set up your account and the desktop app, and get your first games in.",
  },
  {
    id: "desktop-app",
    name: "Desktop app",
    description: "Install, pair and run the app that reads your replays.",
  },
  {
    id: "analyzer",
    name: "Analyzer",
    description: "Today, trends, maps, macro and the rest of your stats.",
  },
  {
    id: "game-page",
    name: "Game page",
    description: "One game in detail: build order, timeline and replay.",
  },
  {
    id: "opponents",
    name: "Opponents",
    description: "Scouting reports, head-to-head records and opponent history.",
  },
  {
    id: "builds",
    name: "Builds",
    description: "Custom builds, build check-in and how games are matched to builds.",
  },
  {
    id: "reviews-coaching",
    name: "Reviews & coaching",
    description: "Ask other players about a moment in your game, review theirs, and the private coaching workspace.",
  },
  {
    id: "stream-studio",
    name: "Stream Studio",
    description: "Overlay widgets, multi-platform chat, the Stream Dock and viewer features.",
  },
  {
    id: "account-data",
    name: "Account & data",
    description: "Your account, privacy, backups and your replay library.",
  },
  {
    id: "troubleshooting",
    name: "Troubleshooting",
    description: "Fixes for common problems, and how to reach us.",
  },
];

const BY_ID = new Map(HELP_CATEGORIES.map((category) => [category.id, category]));

/**
 * The category record for an id.
 *
 * Example: `helpCategory("builds").name` → "Builds".
 */
export function helpCategory(id: HelpCategoryId): HelpCategory {
  const category = BY_ID.get(id);
  if (!category) throw new Error(`Unknown help category: ${id}`);
  return category;
}

/** True for a known category id. */
export function isHelpCategoryId(value: unknown): value is HelpCategoryId {
  return typeof value === "string" && BY_ID.has(value as HelpCategoryId);
}
