/** Public tour copy and target ownership. Never put account data in this registry. */
export type TourId = "today" | "game" | "overlay";
export type TourStep = { readonly target: string; readonly owner: string; readonly title: string; readonly text: string; readonly help?: string };
export type TourDefinition = { readonly id: TourId; readonly version: number; readonly title: string; readonly steps: readonly TourStep[] };
export type TourVersions = Partial<Record<TourId, number>>;
export type TourAvailabilityScope = { active: boolean; path: string; recordKey: string; current: () => boolean };
export type TourAvailability = { available: boolean; scope: TourAvailabilityScope };
export const ONBOARDING_PREFERENCES_PATH = "/v1/me/preferences/onboarding";
export const MAX_TOUR_VERSION = 1_000;
export const tourAvailabilityKey = (owner: string, id: TourId) => ["tour-target-availability", owner, id, TOURS[id].version] as const;

export const TOURS = {
  today: { id: "today", version: 1, title: "A quick look at Today", steps: [
    { target: "today-summary", owner: "components/dashboard/TodayView.tsx", title: "Today at a glance", text: "Start with today's games, win rate, streak and rating. Each card explains the window it uses." },
    { target: "today-next-steps", owner: "components/onboarding/LevelUpChecklist.tsx", title: "Try a useful next step", text: "These suggestions follow your playing and streaming goals. You can dismiss them independently of this tour." },
    { target: "today-daily-pulse", owner: "components/dashboard/TodayView.tsx", title: "Notice a pattern", text: "Daily Pulse highlights patterns from your recorded games. Open an insight when you want its supporting games." },
    { target: "today-ladder-pulse", owner: "components/dashboard/TodayView.tsx", title: "Find a game to review", text: "Ladder Pulse connects your recent games to useful review links. Open Help for the meaning behind your stats.", help: "/help/reading-your-stats" },
  ] },
  game: { id: "game", version: 1, title: "Read your game breakdown", steps: [
    { target: "game-navigation", owner: "components/analyzer/game/GameWorkspaceNav.tsx", title: "One game, several views", text: "The section links move through this game's report while keeping its replay loaded." },
    { target: "game-replay", owner: "components/analyzer/game/GameDetailPage.tsx", title: "Inspect a moment", text: "The replay controls and game clock connect the map to events elsewhere in the report. Older games may have less playback data." },
    { target: "game-macro", owner: "components/analyzer/game/GameDetailPage.tsx", title: "Understand your macro", text: "Compare the timeline and economy breakdown. Inspecting this chart keeps you at the chart; replay links can take you to the map." },
    { target: "game-builds", owner: "components/analyzer/game/GameDetailPage.tsx", title: "Compare the build orders", text: "Read the recorded steps for both players and compare them with your plan. The first-game guide explains how these views fit together.", help: "/help/your-first-game" },
  ] },
  overlay: { id: "overlay", version: 1, title: "Set up your overlay", steps: [
    { target: "overlay-setup", owner: "components/analyzer/settings/SettingsOverlay.tsx", title: "Connect a Browser Source", text: "Copy a private source URL into OBS. A connected preview is different from a public broadcast." },
    { target: "overlay-widgets", owner: "components/analyzer/settings/SettingsOverlay.tsx", title: "Choose the widgets you need", text: "Review the enabled widgets and their sizes. Taking this tour does not enable widgets or send live tests." },
    { target: "overlay-scenes", owner: "components/analyzer/settings/OverlayScenesSection.tsx", title: "Arrange a scene", text: "Scenes bring widgets together in one source. Their controls explain which layout and URLs you are changing." },
    { target: "overlay-theme", owner: "components/analyzer/settings/OverlayThemeSection.tsx", title: "Make it your own", text: "Choose a look that stays readable over your stream. The Stream Studio crash course walks through a complete setup.", help: "/stream-studio/learn#crash-course" },
  ] },
} as const satisfies Record<TourId, TourDefinition>;

export function isTourId(value: unknown): value is TourId { return value === "today" || value === "game" || value === "overlay"; }
export function isTourVersion(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_TOUR_VERSION; }
export function validTourGameId(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value); }
export function tourVersions(value: unknown): TourVersions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.keys(TOURS).flatMap(id => {
    const version: unknown = Object.hasOwn(value, id) ? (value as Record<string, unknown>)[id] : undefined;
    return isTourVersion(version) ? [[id, version]] : [];
  }));
}
export function tourIsDone(id: TourId, value: unknown): boolean { return (tourVersions(value)[id] ?? 0) >= TOURS[id].version; }
/** A previous record's failed probe must never hide another route's replay action. */
export function tourUnavailable(value: unknown, pathname: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "available") || !Object.hasOwn(value, "scope") || (value as TourAvailability).available !== false) return false;
  const scope = (value as TourAvailability).scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope) || !Object.hasOwn(scope, "active") || !Object.hasOwn(scope, "path") || !Object.hasOwn(scope, "current") || scope.active !== true || scope.path !== pathname || typeof scope.current !== "function") return false;
  try { return scope.current() === true; } catch { return false; }
}
/** Missing targets never substitute a made-up target. More than half missing prevents a start. */
export function tourStepsPresent(id: TourId, present: ReadonlySet<string>): readonly TourStep[] | null {
  const steps: readonly TourStep[] = TOURS[id].steps;
  const available = steps.filter(step => present.has(step.target));
  return available.length * 2 < steps.length ? null : available;
}
export function tourReplayHref(id: "today" | "overlay"): string;
export function tourReplayHref(id: "game", gameId?: string): string | null;
export function tourReplayHref(id: TourId, gameId?: string): string | null {
  if (id === "today") return "/app?tour=today";
  if (id === "overlay") return "/settings?tab=overlay&tour=overlay";
  return validTourGameId(gameId) ? "/app/game/" + encodeURIComponent(gameId) + "?tour=game" : null;
}
