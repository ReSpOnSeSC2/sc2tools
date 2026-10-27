/** Owner-scoped feature discovery, independent of the first-import checklist. */
export const ACTIVATION_PATH = "/v1/me/activation";
export const FIRST_GAME_VIEWED_PATH = "/v1/me/activation/first-game";
export type ActivationGoal = "improve" | "stream";
export type ActivationFlag = "identity" | "firstGameViewed" | "customBuild" | "checkIn" | "overlayLive" | "chatOn";
export type ActivationResponse = Record<ActivationFlag, boolean> & {
  goals: ActivationGoal[];
  levelUpDismissedAt: string | null;
};

export type ActivationRow = {
  id: ActivationFlag;
  goal?: ActivationGoal;
  title: string;
  why: string;
  href: string;
  action: string;
  help: string;
};

const ROWS: readonly ActivationRow[] = [
  { id: "identity", title: "Add your SC2 identity", why: "Connect your profile with the players and ratings in your replays.", href: "/settings?tab=profile", action: "Open Profile", help: "setup-health" },
  { id: "firstGameViewed", title: "Open a recorded game", why: "See its build, replay timeline and macro breakdown.", href: "/app/replays", action: "Browse replays", help: "game-page" },
  { id: "customBuild", goal: "improve", title: "Create a build", why: "Save an opening you want to practice and compare with your games.", href: "/builds", action: "Open Builds", help: "custom-builds" },
  { id: "checkIn", goal: "improve", title: "Check in a build", why: "Record your plan so you can compare it with what happened.", href: "/settings?tab=checkin", action: "Set up check-in", help: "build-check-in" },
  { id: "overlayLive", goal: "stream", title: "Connect an overlay link", why: "Try a private overlay URL in your stream setup.", href: "/settings?tab=overlay", action: "Open Overlay", help: "obs-overlay-setup" },
  { id: "chatOn", goal: "stream", title: "Enable a chat platform", why: "Bring your enabled platforms into one chat view.", href: "/settings?tab=chat#platforms", action: "Open Chat & alerts", help: "multi-platform-chat" },
];

/** Empty, malformed or unknown goals keep all features discoverable. */
export function activationRows(goals: unknown): readonly ActivationRow[] {
  const selected = Array.isArray(goals) && goals.length > 0 && goals.length <= 2 && goals.every(goal => goal === "improve" || goal === "stream")
    ? new Set<ActivationGoal>(goals) : new Set<ActivationGoal>(["improve", "stream"]);
  return ROWS.filter(row => !row.goal || selected.has(row.goal));
}

export function activationProgress(value: ActivationResponse) {
  const rows = activationRows(value.goals);
  const done = rows.filter(row => value[row.id]).length;
  return { rows, done, total: rows.length, complete: done === rows.length };
}

export function validActivation(value: unknown): value is ActivationResponse {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return ROWS.every(row => typeof data[row.id] === "boolean") && Array.isArray(data.goals) && data.goals.length <= 2
    && data.goals.every(goal => goal === "improve" || goal === "stream")
    && (data.levelUpDismissedAt === null || validTimestamp(data.levelUpDismissedAt));
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
