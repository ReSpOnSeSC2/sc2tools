"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { Bug, Mail } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { errorReportMailto, errorReportSubject } from "@/lib/feedback/errorReport";
import { isTokenAuthRoute } from "@/lib/tokenAuthRoutes";
import { LazyReportIssueModal } from "./LazyReportIssueModal";

/** A link dressed as the secondary Button, so both states of the action match. */
const SECONDARY_LINK_CLASS = [
  "hard-press inline-flex h-11 min-w-[44px] items-center justify-center gap-2 rounded-full px-5",
  "border-2 border-line bg-bg-surface font-display text-body font-bold tracking-tight text-text hover:bg-bg-elevated",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
].join(" ");

/**
 * "Report this problem" on an error screen: opens the report form as a
 * Problem with "Error on <path> (ref <digest>)" as the subject. The form
 * and the API need an account, so signed-out visitors, and the OBS
 * browser-source pages (which run without Clerk), get an email link that
 * carries the same reference instead.
 */
export function ReportErrorAction({ digest }: { digest?: string }) {
  const pathname = usePathname() ?? "/";
  // Browser-source pages render without ClerkProvider: useAuth would throw.
  if (isTokenAuthRoute(pathname)) return <EmailErrorLink pathname={pathname} digest={digest} />;
  return <ReportErrorForm pathname={pathname} digest={digest} />;
}

function ReportErrorForm({ pathname, digest }: { pathname: string; digest?: string }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [open, setOpen] = useState(false);
  if (!isLoaded || !isSignedIn) return <EmailErrorLink pathname={pathname} digest={digest} />;
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        iconLeft={<Bug className="h-4 w-4" aria-hidden />}
      >
        Report this problem
      </Button>
      <LazyReportIssueModal
        open={open}
        onClose={() => setOpen(false)}
        initialType="problem"
        initialSubject={errorReportSubject(pathname, digest)}
      />
    </>
  );
}

function EmailErrorLink({ pathname, digest }: { pathname: string; digest?: string }) {
  return (
    <a href={errorReportMailto({ pathname, digest })} className={SECONDARY_LINK_CLASS}>
      <Mail className="h-4 w-4" aria-hidden />
      Email us about it
    </a>
  );
}
