"use client";

import { useEffect } from "react";
import { GuideUnavailable } from "@/components/guides/GuideStates";

/**
 * Error boundary of the /guides pages: a render error in a guide page
 * (e.g. `GuideUnavailableError` while the guide API is down) shows the
 * guide-specific noindex "temporarily unavailable" state instead of the
 * root boundary's dashboard-oriented "Something broke" page. (A failed
 * first render of an ISR guide page on the server is answered by Next's
 * own uncached 500 response instead; see lib/guides/guideErrors.ts.) The
 * server logs the error itself; the client only notes the digest.
 */
export default function GuidesError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.warn("guide_unavailable", { digest: error.digest ?? null });
  }, [error]);

  return (
    <>
      <meta name="robots" content="noindex, nofollow" />
      <GuideUnavailable />
    </>
  );
}
