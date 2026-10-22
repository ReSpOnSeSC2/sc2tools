"use client";

import { RequestError } from "@/components/ui/RequestError";
import type { ClientApiError } from "@/lib/clientApi";
import { useTrendsDataScope } from "@/lib/trendsDataContext";

/**
 * A Trends chart whose request failed: the shared RequestError inside
 * the chart's card, so one failed chart never blanks the tab. In the
 * admin's global trends a timeout also suggests a smaller player
 * selection.
 */
export function TrendsRequestError({
  title,
  retry,
  error,
}: {
  title: string;
  retry: () => unknown;
  error?: ClientApiError;
}) {
  const { isGlobal } = useTrendsDataScope();
  return (
    <RequestError
      title={title}
      error={error}
      onRetry={retry}
      filtered
      copy={
        isGlobal
          ? { timeout: { body: "The server didn't answer in time. Try again, or narrow the date range or the player selection." } }
          : undefined
      }
    />
  );
}
