"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useApi, type ClientApiError } from "@/lib/clientApi";
import { useToast } from "@/components/ui/Toast";
import { confirmLockerBackup, loadLockerBackup, stageLockerBackup } from "./lockerBackup";
import type { LockerDocument, LockerState } from "./lockerRosterModel";

export function useLockerRoster(accountId: string, role: "admin" | "coach", coachId: string | null) {
  const document = useApi<LockerDocument>("/v1/coaching/state?roster=1", { revalidateOnFocus: true });
  const current = !document.error && document.data?.scoped === (role === "coach") ? document.data : undefined;
  const scope = useMemo(() => [accountId, "roster:" + role + ":" + (coachId ?? "")] as const, [accountId, role, coachId]);
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
    if (saving.current) return false;
    if (!current || current.rev !== fromRev) {
      toast.warning("The Locker changed", { description: "Open the editor again to review the latest version." });
      return false;
    }
    saving.current = true;
    setBusy(true);
    try {
      try {
        await stageLockerBackup(scope, current);
      } catch {
        toast.error("Backup could not be saved", { description: "Allow site storage or use the classic Locker after exporting a backup." });
        return false;
      }
      const result = await document.request<{ ok: true; rev: number }>({
        method: "PUT", body: JSON.stringify({ state, rev: current.rev }),
      });
      try {
        await confirmLockerBackup(scope, current.rev, result.rev);
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
    backup: backup?.writtenRev === rev ? backup : null,
    busy,
    save,
  };
}
