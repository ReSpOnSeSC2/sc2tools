"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/** Both editors guard the same local draft, regardless of the close control used. */
export function useBuildEditorCloseGuard({ open, dirty, saving, name, onClose }: {
  open: boolean; dirty: boolean; saving: boolean; name: string; onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (!open) setConfirming(false); }, [open]);
  useEffect(() => {
    if (!open || !dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [open, dirty]);
  const requestClose = () => {
    if (saving) return;
    if (dirty) setConfirming(true); else onClose();
  };
  const confirmation = <ConfirmDialog open={open && confirming} onClose={() => setConfirming(false)}
    onConfirm={() => { setConfirming(false); onClose(); }}
    title={`Discard changes to “${name.trim() || "this build"}”?`}
    description="Your rules and preview changes haven't been saved."
    cancelLabel="Keep editing" confirmLabel="Discard" intent="danger" focusCancel />;
  return { requestClose, confirmation };
}
