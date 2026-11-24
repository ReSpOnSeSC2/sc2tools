/**
 * Build-time safety net for when GitHub's release list can't be used. The
 * newest published `agent-v*` release on GitHub stays the source of truth:
 * `/api/agent/version`, the changelog page and the Agent RSS feed read it
 * (lib/agentReleaseSource.server.ts), so none of them waits for this value
 * to change. It shows only before release metadata loads, when that request
 * fails, and where the changelog starts if a build can't reach GitHub.
 *
 * It is shown to players as the version to install, so it must name an agent
 * that is published, never one still being prepared on main: a release commit
 * sets it to the release before the version it prepares. Nothing needs to
 * change once that version is published (raising it then is optional).
 * `version-check` accepts the agent package version or the release before it.
 */
export const FALLBACK_LATEST_AGENT_VERSION = "0.25.9";
export const STREAMS_MIN_AGENT_VERSION = "0.18.0";

export function inactiveAgentMessage(
  version: string | null | undefined,
): string {
  const cleanVersion = typeof version === "string"
    ? version.trim().replace(/^v/i, "")
    : "";
  const label = cleanVersion
    ? `SC2 Tools Agent v${cleanVersion}`
    : "The latest SC2 Tools Agent";
  return `${label} needs to be turned on or installed`;
}
