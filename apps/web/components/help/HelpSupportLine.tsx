"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Bug, Mail } from "lucide-react";
import { LazyReportIssueModal } from "@/components/feedback/LazyReportIssueModal";
import { Button } from "@/components/ui/Button";
import { HELP_SUPPORT_EMAIL } from "@/lib/help/support";
import { HELP_TEXT_LINK_CLASS } from "./HelpInline";

/**
 * "Still stuck?" at the end of every help surface. Signed-in players get
 * the in-app "Report a problem" form (the same one as the Help menu, which
 * needs an account); everyone gets the support email.
 *
 *   variant="line" (default): one sentence, for article pages and sheets.
 *   variant="panel": a "Report a problem" button with the email as the
 *     fallback line under it, for Settings → Help.
 */
export function HelpSupportLine({
  className = "",
  variant = "line",
}: {
  className?: string;
  variant?: "line" | "panel";
}) {
  const { isLoaded, isSignedIn } = useAuth();
  const [open, setOpen] = useState(false);
  const canReport = isLoaded && isSignedIn === true;
  const email = (
    <a href={`mailto:${HELP_SUPPORT_EMAIL}`} className={HELP_TEXT_LINK_CLASS}>
      {HELP_SUPPORT_EMAIL}
    </a>
  );
  const modal = canReport ? <LazyReportIssueModal open={open} onClose={() => setOpen(false)} /> : null;

  if (variant === "panel") {
    return (
      <div className={["space-y-3", className].filter(Boolean).join(" ")}>
        <div>
          <h3 className="text-body font-semibold text-text">Still stuck?</h3>
          <p className="text-caption text-text-muted">
            Tell us what went wrong and we&apos;ll take a look.
          </p>
        </div>
        {canReport ? (
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Bug className="h-4 w-4" aria-hidden />}
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
          >
            Report a problem
          </Button>
        ) : null}
        <p className="flex items-start gap-2 text-caption text-text-muted">
          <Mail className="mt-0.5 h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
          <span>
            {canReport ? "Or email " : "Email "}
            {email} — include what you clicked and a screenshot if you can.
          </span>
        </p>
        {modal}
      </div>
    );
  }

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
        {email} — include what you clicked and a screenshot if you can.
      </p>
      {modal}
    </div>
  );
}
