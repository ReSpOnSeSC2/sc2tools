"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Mail } from "lucide-react";
import { ReportIssueModal } from "@/components/feedback/ReportIssueModal";
import { HELP_SUPPORT_EMAIL } from "@/lib/help/support";
import { HELP_TEXT_LINK_CLASS } from "./HelpInline";

/**
 * "Still stuck?" line at the end of every help surface. Signed-in
 * players get the in-app "Report a problem" form (the same one as the
 * footer's Report a bug, which needs an account); everyone gets the
 * support email.
 */
export function HelpSupportLine({ className = "" }: { className?: string }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [open, setOpen] = useState(false);
  const canReport = isLoaded && isSignedIn === true;

  return (
    <div className={["flex items-start gap-2 text-body text-text-muted", className].filter(Boolean).join(" ")}>
      <Mail className="mt-1 h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
      <p>
        Still stuck?{" "}
        {canReport ? (
          <>
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-haspopup="dialog"
              className={HELP_TEXT_LINK_CLASS}
            >
              Report a problem
            </button>{" "}
            or email{" "}
          </>
        ) : (
          "Email "
        )}
        <a href={`mailto:${HELP_SUPPORT_EMAIL}`} className={HELP_TEXT_LINK_CLASS}>
          {HELP_SUPPORT_EMAIL}
        </a>{" "}
        — include what you clicked and a screenshot if you can.
      </p>
      {canReport ? <ReportIssueModal open={open} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
