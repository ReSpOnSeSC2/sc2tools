import { requestErrorCopy, toClientApiError } from "@/lib/requestErrors";

const COPY: Record<string, string> = {
  backups_unavailable: "Backup storage is unavailable. Your saved data hasn't changed. Try again later or contact support.",
  replay_archive_unavailable: "Replay archive storage is unavailable. Try again later or contact support.",
  backup_migration_required: "This older snapshot is being prepared for the new backup format. Contact support if it stays unavailable.",
  backup_invalid: "This snapshot could not be verified. Your saved data hasn't changed. Try another snapshot or contact support.",
  backup_preview_changed: "Your game history changed after this preview. Review the updated changes before restoring.",
  invalid_backup_label: "Use a label of up to 80 characters without control characters.",
  repair_rate_limited: "This repair can run once an hour. Try again after the cooldown.",
  gdpr_operation_busy: "Another import or data action is running. Let it finish, then try again.",
  snapshot_not_found: "This snapshot is no longer available. Refresh the list and choose another.",
};
export function backupErrorMessage(error: unknown): string {
  const value = toClientApiError(error);
  return COPY[value.code || ""] || requestErrorCopy(error).body;
}
