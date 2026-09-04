/**
 * Build-time safety net for the brief window before release metadata loads.
 * The live `/api/agent/version` response remains the source of truth.
 */
export const FALLBACK_LATEST_AGENT_VERSION = "0.16.3";

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
