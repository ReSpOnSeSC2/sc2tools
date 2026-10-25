"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { drawReportCard, reportPng } from "@/lib/instant/reportCard";
import { defaultReportSelection, reportCardModel, reportCardText, type ReportSelection } from "@/lib/instant/reportSharing";
import { trackInstantReportShared } from "@/lib/instant/analytics";
import type { InstantReport } from "@/lib/instant/report";

export interface ShareReportDialogProps { report: InstantReport; onClose(): void }

export function ShareReportDialog({ report, onClose }: ShareReportDialogProps) {
  const available = useMemo(() => reportCardModel(report), [report]);
  const [selection, setSelection] = useState<ReportSelection>(() => defaultReportSelection(available));
  const model = useMemo(() => reportCardModel(report, selection), [report, selection]);
  const scope = useMemo(() => ({ report, selection }), [report, selection]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const canvas = useRef<HTMLCanvasElement>(null);
  const active = useRef(true);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setBusy(false); }, [scope]);
  useEffect(() => { try { if (canvas.current) drawReportCard(canvas.current, model); setStatus(""); } catch { setStatus("PNG previews are unavailable in this browser. You can still copy the text."); } }, [model]);
  const text = reportCardText(model);
  const empty = !model.totals && !model.matchups.length && !model.opener && !model.macro;
  async function deliver(method: "web_share" | "download" | "text") {
    if (busy || empty) return;
    const operation = currentScope.current;
    const current = () => active.current && currentScope.current === operation;
    setBusy(true); setStatus("");
    try {
      if (method === "text") await navigator.clipboard.writeText(text);
      else {
        if (!canvas.current) throw new Error("Preview unavailable");
        const blob = await reportPng(canvas.current);
        if (!current()) return;
        if (method === "web_share") {
          const data = { title: "My SC2 replay report", text, files: [new File([blob], "sc2tools-report.png", { type: "image/png" })] };
          if (!navigator.share || !navigator.canShare?.(data)) { setStatus("Use Download PNG or Copy text on this browser."); return; }
          await navigator.share(data);
        } else {
          const url = URL.createObjectURL(blob), link = document.createElement("a");
          link.href = url; link.download = "sc2tools-report.png"; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      }
      if (current()) { setStatus(method === "text" ? "Report text copied." : method === "download" ? "PNG downloaded." : "Report shared."); trackInstantReportShared(method); }
    } catch (error) { if (current()) setStatus(error instanceof DOMException && error.name === "AbortError" ? "Sharing cancelled." : "That action was unavailable. Try Download PNG or copy the text below."); }
    finally { if (current()) setBusy(false); }
  }
  function toggle(key: "totals" | "opener" | "macro") { setSelection((old) => ({ ...old, [key]: !old[key] })); }
  return <Modal open onClose={onClose} title="Share your report" description="Choose the rows to include. Player names, accounts, individual games and replay files are excluded." size="xl">
    <fieldset disabled={busy} className="mb-4 flex flex-wrap gap-x-5 gap-y-3"><legend className="mb-2 font-semibold">Include in the image and text</legend>
      {available.totals ? <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selection.totals} onChange={() => toggle("totals")} />Totals</label> : null}
      {available.matchups.map((row) => { const race = row.label.slice(-1); return <label key={race} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selection.matchups.includes(race)} onChange={() => setSelection((old) => ({ ...old, matchups: old.matchups.includes(race) ? old.matchups.filter((r) => r !== race) : [...old.matchups, race] }))} />{row.label}</label>; })}
      {available.opener ? <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selection.opener} onChange={() => toggle("opener")} />Best opener</label> : null}
      {available.macro ? <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selection.macro} onChange={() => toggle("macro")} />Macro score</label> : null}
    </fieldset>
    <canvas ref={canvas} role="img" aria-label={text} className="h-auto w-full rounded-lg border border-line" />
    <p className="mt-2 text-caption text-text-muted">1200 × 630 PNG · best opener requires at least three games · win/loss bars use decided games.</p>
    <div className="mt-4 flex flex-wrap gap-2"><Button disabled={busy || empty} onClick={() => void deliver("web_share")}>Share PNG</Button><Button variant="secondary" disabled={busy || empty} onClick={() => void deliver("download")}>Download PNG</Button><Button variant="secondary" disabled={busy || empty} onClick={() => void deliver("text")}>Copy text</Button></div>
    <p role="status" className="mt-3 text-caption text-text-muted">{empty ? "Select at least one row." : status}</p>
    <details className="mt-3"><summary className="min-h-11 cursor-pointer font-semibold">Report text</summary><pre className="whitespace-pre-wrap break-words text-caption">{text}</pre></details>
  </Modal>;
}
