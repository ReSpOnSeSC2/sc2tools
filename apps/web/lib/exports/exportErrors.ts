export type ExportFailure = "busy" | "cancelled" | "failed" | "incomplete" | "invalid" | "too_large";
const MESSAGES: Record<ExportFailure, string> = {
  busy: "Another export is still finishing. Try again when it has stopped.",
  cancelled: "Export cancelled.",
  failed: "Couldn't complete the export. Please try again.",
  incomplete: "The export ended before it was complete. Please try again.",
  invalid: "The server returned an unreadable export. Please try again.",
  too_large: "This export is too large for this browser download. Choose a smaller range or save directly to a file.",
};

export class ExportDownloadError extends Error {
  constructor(readonly code: ExportFailure) {
    super(MESSAGES[code]);
    this.name = "ExportDownloadError";
  }
}
