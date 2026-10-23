"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { Bug, Mail } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { errorReportMailto, errorReportSubject } from "@/lib/feedback/errorReport";
import { isTokenAuthRoute } from "@/lib/tokenAuthRoutes";
import { LazyReportIssueModal } from "./LazyReportIssueModal";

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
        prefill={{ type: "problem", subject: errorReportSubject(pathname, digest) }}
      />
    </>
  );
}

function EmailErrorLink({ pathname, digest }: { pathname: string; digest?: string }) {
  return (
    // Dressed as the secondary Button, so both states of the action match.
    <a href={errorReportMailto({ pathname, digest })} className={buttonClassName({ variant: "secondary" })}>
      <Mail className="h-4 w-4" aria-hidden />
      Email us about it
    </a>
  );
}
