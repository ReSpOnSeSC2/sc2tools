"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApi, type ClientApiError } from "@/lib/clientApi";
import { retryableLockerRead } from "./lockerRosterModel";
import { useToast } from "@/components/ui/Toast";
import { confirmLockerBackup, loadLockerBackup, stageLockerBackup } from "./lockerBackup";
import type { LockerDocument, LockerState } from "./lockerRosterModel";

export function useLockerView(accountId: string, view: "roster" | "shelf" | "worksheets", role: "admin" | "coach" | "student", memberId: string | null) {
  const scope = useMemo(() => [accountId, view + ":" + role + ":" + (memberId ?? "")] as const, [accountId, view, role, memberId]);
  const document = useApi<LockerDocument>(`/v1/coaching/state?${view}=1`, {
    revalidateOnFocus: true,
    keepPreviousData: false,
  });
  const previous = useRef<{ scope: typeof scope; document: LockerDocument } | null>(null);
  const admitted = useRef<LockerDocument | undefined>(undefined);
  const candidate = document.data?.scoped === (role !== "admin") ? document.data : undefined;
  const fresh = document.error ? undefined : candidate;
  const retryable = view !== "roster" && retryableLockerRead(document.error);
  const current = fresh ?? (retryable && previous.current?.scope === scope ? previous.current.document : undefined);
  const refreshRequired = !!current && !fresh;

  useLayoutEffect(() => {
    if (fresh) previous.current = { scope, document: fresh };
    else if (!retryable) previous.current = null;
    admitted.current = fresh;
    return () => { admitted.current = undefined; };
  }, [fresh, retryable, scope]);
  const rev = current?.rev;
  const [backup, setBackup] = useState<Awaited<ReturnType<typeof loadLockerBackup>>>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const { toast } = useToast();

  useEffect(() => {
    let active = true;
    setBackup(null);
    if (rev !== undefined) {
      void loadLockerBackup(scope, rev).then(
        (value) => { if (active) setBackup(value); },
        () => { if (active) setBackup(null); },
      );
    }
    return () => { active = false; };
  }, [scope, rev]);

  async function save(state: LockerState, fromRev: number, message: string): Promise<boolean> {
    if (saving.current || (role === "student" && view !== "worksheets")) return false;
    const authorized = admitted.current;
    if (!authorized || authorized.rev !== fromRev) {
      toast.warning("The Locker changed", { description: "Open the editor again to review the latest version." });
      return false;
    }
    saving.current = true;
    setBusy(true);
    try {
      try {
        await stageLockerBackup(scope, authorized);
      } catch {
        toast.error("Backup could not be saved", { description: "Allow site storage or use the classic Locker after exporting a backup." });
        return false;
      }
      if (admitted.current !== authorized) return false;
      const result = await document.request<{ ok: true; rev: number }>({
        method: "PUT", body: JSON.stringify({ state, rev: authorized.rev }),
      });
      try {
        await confirmLockerBackup(scope, authorized.rev, result.rev);
      } catch {
        toast.warning("The change was saved", { description: "The automatic backup could not be marked ready to restore." });
      }
      toast.success(message);
      await document.mutate();
      return true;
    } catch (error) {
      const apiError = error as Partial<ClientApiError>;
      if (apiError.code === "conflict") {
        toast.warning("The Locker changed", { description: "Review the latest version before trying again." });
        await document.mutate();
      } else if (!(error instanceof DOMException && error.name === "AbortError")) {
        toast.error("The Locker could not save", { description: apiError.message });
      }
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return {
    document: current,
    loading: document.isLoading,
    retry: document.mutate,
    retrying: document.isValidating,
    refreshRequired,
    backup: backup?.writtenRev === rev ? backup : null,
    busy,
    save,
  };
}
