"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { ReportIssueModal } from "./ReportIssueModal";

/**
 * ReportIssueLauncher — footer-link-styled trigger that opens the
 * "Report a bug" modal. Rendered only for signed-in users (the
 * `/v1/messages` endpoint is auth-gated, and reports carry the
 * sender's identity), so signed-out visitors don't see a dead-end.
 *
 * Renders inside the Footer's link list, so it mimics the footer link
 * styling exactly.
 */
export function ReportIssueLauncher() {
  const { isLoaded, isSignedIn } = useAuth();
  const [open, setOpen] = useState(false);

  if (!isLoaded || !isSignedIn) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[28px] items-center text-caption text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
      >
        Report a bug
      </button>
      <ReportIssueModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
