/**
 * Human copy for the desktop agent's skip-reason codes (shared contract
 * with apps/agent replay_pipeline SKIP_* + import_controller). Pure, so
 * Sync health can word a heartbeat's skip counts without pulling in the
 * import-status hook and its socket. components/imports/useImportStatus.ts
 * re-exports these for the import surfaces.
 */
export const ERROR_CODE_COPY: Record<string, string> = {
  parse_failed:
    "File looks corrupt, cut off, or from an unsupported SC2 version.",
  player_unresolved:
    "Couldn't tell which player is you — set your BattleTag in Settings → Profile, then re-import.",
  no_result: "The replay has no recorded result (left during loading?).",
  ai_game: "Skipped — game vs the AI.",
  resumed_replay:
    "Skipped — a replay-resume session is not a new ladder result.",
  filtered: "Skipped — outside your import date range.",
  rejected_by_server: "The server rejected the upload.",
  file_unstable:
    "The file stayed empty or unreadable (interrupted save or cloud-sync lag?). Run Re-sync in the desktop agent to retry it.",
  analysis_failed:
    "The desktop agent hit an unexpected error analysing this replay. Update the agent, then run Re-sync to retry it.",
  analyzer_unavailable: "The agent's parser couldn't load — restart the agent.",
  playback_budget_exceeded:
    "The game's analysis was too large to upload. Update the desktop agent, then run Re-sync to retry it.",
  unsupported_replay: "This replay format isn't supported. Check for a desktop agent update.",
};

/** Skip reasons that mean the importer deliberately ignored a file. */
export const BENIGN_SKIP_CODES = new Set([
  "ai_game",
  "resumed_replay",
  "filtered",
]);

export function isBenignImportSkip(code: string): boolean {
  return BENIGN_SKIP_CODES.has(code);
}
