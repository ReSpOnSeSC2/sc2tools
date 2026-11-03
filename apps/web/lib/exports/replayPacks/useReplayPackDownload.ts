"use client";

import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE, useOwnerRequestScope } from "@/lib/clientApi";
import { exportBusy, subscribeExportBusy } from "../exportAdmission";
import { ExportDownloadError, type ExportFailure } from "../exportErrors";
import { downloadReplayPack, type ReplayPackProgress, type ReplayPackResult } from "./downloadReplayPack";
import type { PackNameMetadata, PackNameTemplate } from "./packNames";

type Feedback = { lifetime: object; message: string; progress?: ReplayPackProgress; result?: ReplayPackResult };
type Operation = { lifetime: object; controller: AbortController; firstStop: ExportFailure | null };

/** D3 supplies the committed query/selection scope; A->B->A creates a new lifetime even for equal strings. */
export function useReplayPackDownload(selectionScope: string) {
  const auth = useAuth(), owner = auth.isLoaded && auth.isSignedIn && auth.userId ? auth.userId : null;
  const runOwned = useOwnerRequestScope(owner, auth.getToken);
  const lifetime = useMemo(() => ({ active: !!owner, selectionScope }), [owner, selectionScope]);
  const latest = useRef(lifetime); latest.current = lifetime;
  const active = useRef<Operation | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const busy = useSyncExternalStore(subscribeExportBusy, exportBusy, () => false);
  useLayoutEffect(() => {
    lifetime.active = !!owner;
    return () => { lifetime.active = false; if (active.current?.lifetime === lifetime) active.current.controller.abort(); };
  }, [owner, lifetime]);
  const current = () => lifetime.active && latest.current === lifetime;

  async function run(rows: readonly PackNameMetadata[], template: PackNameTemplate): Promise<boolean> {
    if (!owner || !current() || exportBusy()) return false;
    const operation: Operation = { lifetime, controller: new AbortController(), firstStop: null }; active.current = operation;
    setFeedback({ lifetime, message: "Preparing replay pack…" });
    try {
      const result = await runOwned(owner, (token, signal, assertOwner) => downloadReplayPack({ apiUrl: `${API_BASE}/v1/replays/download-batch`, rows, template }, {
        token, signal, assertCurrent: () => { assertOwner(); if (!current()) throw new DOMException("Retired replay pack", "AbortError"); },
        onProgress: progress => { if (current()) setFeedback({ lifetime, message: "Saving replay pack…", progress }); },
        onStop: code => { operation.firstStop ||= code; },
      }), undefined, operation.controller.signal);
      if (!current()) return false;
      setFeedback({ lifetime, message: result.failed ? `Replay pack saved: ${result.saved} saved, ${result.failed} unavailable or failed.` : "Replay pack saved.", result });
      return true;
    } catch (error) {
      const code = operation.firstStop || (error instanceof ExportDownloadError ? error.code : operation.controller.signal.aborted ? "cancelled" : "failed");
      if (current()) setFeedback({ lifetime, message: new ExportDownloadError(code).message });
      return false;
    } finally { if (active.current === operation) active.current = null; }
  }
  return { owner, busy, feedback: feedback?.lifetime === lifetime ? feedback : null, run,
    cancel: () => { if (active.current?.lifetime === lifetime) active.current.controller.abort(); },
    clear: () => { if (current()) setFeedback(null); } };
}
