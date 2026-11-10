/**
 * Build-time safety net for the brief window before release metadata loads.
 * The live `/api/agent/version` response remains the source of truth.
 *
 * It is shown to players as the version to install, so it names the newest
 * agent that is published, never one still being prepared on main. Raise it
 * when that release is out; `version-check` accepts the agent package version
 * or the release before it.
 */
export const FALLBACK_LATEST_AGENT_VERSION = "0.24.11";
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
