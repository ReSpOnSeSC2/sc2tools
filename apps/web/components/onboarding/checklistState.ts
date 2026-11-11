export type ChecklistMe = {
  games: { total: number };
  agentPaired: boolean;
  agentLastSeenAt?: string | null;
  onboarding?: { downloadStartedAt?: string; dismissedAt?: string | null; [field: string]: unknown } | null;
};

export type ChecklistOptions = {
  /** Instant Analysis flag: games can arrive without any agent. */
  browserImportEnabled?: boolean;
};

/**
 * Server-derived completion state for the three steps. With browser
 * import enabled, games alone finish it: a browser-only player never
 * pairs an agent and must not see the agent checklist forever.
 */
export function checklistVisible(
  me: ChecklistMe,
  options: ChecklistOptions = {},
): boolean {
  if (me.onboarding?.dismissedAt) return false;
  if (options.browserImportEnabled && me.games.total > 0) return false;
  return !(me.agentPaired && me.games.total > 0);
}
