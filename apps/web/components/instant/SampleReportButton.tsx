"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import { Button } from "@/components/ui/Button";
import { SAMPLE_REPORT_AVAILABLE } from "@/lib/instant/sampleAvailability.generated";

/** No sample, report code or engine pointer is fetched until the button is used. */
export function SampleReportButton({ mobileOnly = false }: { mobileOnly?: boolean }) {
  const [Preview, setPreview] = useState<ComponentType | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current += 1; }, []);
  if (!SAMPLE_REPORT_AVAILABLE) return null;
  async function show() {
    if (Preview) { setOpen((value) => !value); return; }
    const current = ++attempt.current;
    setLoading(true); setError("");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const loaded = await Promise.race([import("./SampleReportPreview"), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Preview load timed out")), 20_000);
      })]);
      if (attempt.current !== current) return;
      setPreview(() => loaded.SampleReportPreview); setOpen(true);
    } catch { if (attempt.current === current) setError("Could not load the sample. Try again."); }
    finally { clearTimeout(timer); if (attempt.current === current) setLoading(false); }
  }
  return <div className={`space-y-4 ${mobileOnly ? "mt-4 sm:hidden" : ""}`}>
    <Button variant="secondary" disabled={loading} onClick={() => void show()} aria-expanded={open}>{loading ? "Loading sample…" : open ? "Hide sample report" : error ? "Retry sample report" : "See a sample report"}</Button>
    {error ? <p role="alert" className="text-caption text-text-muted">{error}</p> : null}
    {Preview && open ? <Preview /> : null}
  </div>;
}
