"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import { Button } from "@/components/ui/Button";
import type { InstantReport } from "@/lib/instant/report";
import type { ShareReportDialogProps } from "./ShareReportDialog";

/** The canvas/catalog/dialog code loads only after this explicit action. */
export function ShareReportButton({ report }: { report: InstantReport }) {
  const [Dialog, setDialog] = useState<ComponentType<ShareReportDialogProps> | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current += 1; }, []);
  async function show() {
    if (Dialog) { setOpen(true); return; }
    const current = ++attempt.current;
    setLoading(true); setError("");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const loaded = await Promise.race([import("./ShareReportDialog"), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The preview took too long to load. Try again.")), 20_000);
      })]);
      if (attempt.current !== current) return;
      setDialog(() => loaded.ShareReportDialog); setOpen(true);
    } catch { if (attempt.current === current) setError("Could not load the share preview. Try again."); }
    finally { clearTimeout(timer); if (attempt.current === current) setLoading(false); }
  }
  return <><Button variant="secondary" disabled={loading} onClick={() => void show()}>{loading ? "Loading preview…" : error ? "Retry share preview" : "Share report"}</Button>
    {error ? <p role="alert" className="text-caption text-text-muted">{error}</p> : null}
    {Dialog && open ? <Dialog report={report} onClose={() => setOpen(false)} /> : null}</>;
}
