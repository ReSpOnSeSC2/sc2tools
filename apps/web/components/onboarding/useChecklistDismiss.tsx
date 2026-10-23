"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import { useToastOptional } from "@/components/ui/Toast";

/** Five-second Undo: commit once on expiry, or when leaving the dashboard. */
export function useChecklistDismiss() {
  const { getToken } = useAuth();
  const toast = useToastOptional()?.toast;
  const [dismissed, setDismissed] = useState(false);
  const active = useRef(true);
  const pending = useRef<{ timer?: ReturnType<typeof setTimeout>; send: () => void; toastId?: string } | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; pending.current?.send(); }; }, []);

  function undo() {
    const entry = pending.current; if (!entry) return;
    pending.current = null; clearTimeout(entry.timer);
    if (entry.toastId) toast?.dismiss(entry.toastId);
    setDismissed(false);
  }

  function dismiss() {
    if (pending.current) return;
    setDismissed(true);
    const dismissedAt = new Date().toISOString();
    // Capture this account's token while the user clicks, so a subsequent
    // account switch cannot apply the pending preference to another account.
    const token = getToken().catch(() => null);
    const entry = { send: () => {
      if (pending.current !== entry) return;
      pending.current = null; clearTimeout(entry.timer);
      void apiCall(() => token, "/v1/me/preferences/onboarding", { method: "PUT", body: JSON.stringify({ dismissedAt }) }).catch(() => {
        if (active.current) setDismissed(false);
        toast?.error("Couldn't hide the setup checklist", { description: "Your saved preferences haven't changed. Please try again." });
      });
    }, timer: undefined as ReturnType<typeof setTimeout> | undefined, toastId: undefined as string | undefined };
    pending.current = entry;
    entry.timer = setTimeout(entry.send, 5000);
    entry.toastId = toast?.info("Setup checklist hidden", { duration: 5000, description: <button type="button" className="text-accent underline" onClick={undo}>Undo</button> });
  }

  const hiddenNotice = !toast && dismissed ? <p role="status">Setup checklist hidden. <button type="button" className="text-accent underline" onClick={undo}>Undo</button></p> : null;
  return { dismissed, dismiss, hiddenNotice };
}
