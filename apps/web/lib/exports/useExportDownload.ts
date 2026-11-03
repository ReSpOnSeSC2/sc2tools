"use client";

import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";
import { useOwnerRequestScope } from "@/lib/clientApi";
import { exportBusy, subscribeExportBusy, withExportAdmission } from "./exportAdmission";
import { ExportDownloadError } from "./exportErrors";
import { downloadExport, type DownloadRequest } from "./downloadExport";

type Feedback = { lifetime: object; bytes: number; message: string; continuation: string | null };

/** The private API UUID is read from the shell's existing owner-keyed cache, without an extra profile request. */
export function useExportDownload() {
  const auth = useAuth(), owner = auth.isLoaded && auth.isSignedIn && auth.userId ? auth.userId : null;
  const runOwned = useOwnerRequestScope(owner, auth.getToken);
  const lifetime = useMemo(() => ({ active: !!owner }), [owner]);
  const latest = useRef(lifetime); latest.current = lifetime;
  const controller = useRef<{ lifetime: object; value: AbortController } | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const busy = useSyncExternalStore(subscribeExportBusy, exportBusy, () => false);
  const { data: me } = useSWR<{ userId?: unknown }>(owner ? ["authenticated-api", owner, "/v1/me"] : null, null, {
    keepPreviousData: false, revalidateOnMount: false, revalidateOnFocus: false, revalidateOnReconnect: false,
  });
  useLayoutEffect(() => {
    lifetime.active = !!owner;
    return () => {
      lifetime.active = false;
      if (controller.current?.lifetime === lifetime) controller.current.value.abort();
    };
  }, [owner, lifetime]);
  const current = () => lifetime.active && latest.current === lifetime;
  const visible = feedback?.lifetime === lifetime ? feedback : null;

  async function run(request: DownloadRequest, onComplete?: (result: { bytes: number; continuation: string | null }) => void): Promise<boolean> {
    if (!owner || !current() || exportBusy()) return false;
    const operation = { lifetime, value: new AbortController() };
    controller.current = operation;
    setFeedback({ lifetime, bytes: 0, message: "Preparing export…", continuation: null });
    try {
      const result = await runOwned(owner, (token, signal, assertCurrent) => withExportAdmission(() =>
        downloadExport(request, { token, signal, assertCurrent, onProgress: bytes => {
          if (current()) setFeedback({ lifetime, bytes, message: "Downloading…", continuation: null });
        } })), undefined, operation.value.signal);
      if (!current()) return false;
      setFeedback({ lifetime, bytes: result.bytes, message: "Export saved. Check your downloads or the file you selected.", continuation: result.continuation });
      onComplete?.(result);
      return true;
    } catch (error) {
      if (current()) {
        const safe = error instanceof ExportDownloadError ? error : new ExportDownloadError(operation.value.signal.aborted ? "cancelled" : "failed");
        setFeedback({ lifetime, bytes: 0, message: safe.message, continuation: null });
      }
      return false;
    } finally { if (controller.current === operation) controller.current = null; }
  }

  return { owner, apiOwner: typeof me?.userId === "string" && me.userId.length > 0 ? me.userId : null,
    busy, feedback: visible, run,
    cancel: () => { if (controller.current?.lifetime === lifetime) controller.current.value.abort(); },
    clear: () => setFeedback(null) };
}
