"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { drawReportCard, reportPng } from "@/lib/instant/reportCard";
import { reportCardLink } from "@/lib/instant/reportCardLink";
import { defaultReportSelection, reportCardModel, type ReportSelection } from "@/lib/instant/reportSharing";
import { reportSummaryText } from "@/lib/instant/reportExport";
import { DEFAULT_REPORT_FILTERS, reportFilterLabel, type ReportFilters } from "@/lib/instant/reportFilters";
import { trackInstantReportShared } from "@/lib/instant/analytics";
import type { InstantReport } from "@/lib/instant/report";
import { useCopy } from "@/lib/useCopy";

export interface ShareReportDialogProps {
  /** The report on screen: the filtered one when report filters are active. */
  report: InstantReport;
  filters?: ReportFilters;
  commanderCode?: number | null;
  onClose(): void;
}

export function ShareReportDialog({ report, filters = DEFAULT_REPORT_FILTERS, commanderCode, onClose }: ShareReportDialogProps) {
  const available = useMemo(() => reportCardModel(report, undefined, commanderCode), [report, commanderCode]);
  const [selection, setSelection] = useState<ReportSelection>(() => defaultReportSelection(available));
  const model = useMemo(() => reportCardModel(report, selection, commanderCode), [report, selection, commanderCode]);
  const scope = useMemo(() => ({ report, selection, commanderCode }), [report, selection, commanderCode]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const canvas = useRef<HTMLCanvasElement>(null);
  const active = useRef(true);
  const [status, setStatus] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const copyButton = useRef<HTMLButtonElement>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  const copyKind = useRef<"text" | "link">("text");
  const copyInputId = useId();
  const copyHelpId = useId();
  const clipboard = useCopy({
    scopeKey: scope,
    onCopied: () => {
      setStatus(copyKind.current === "link" ? "Card link copied." : "Report text copied.");
      trackInstantReportShared(copyKind.current);
    },
    onFallback: () => setStatus(copyKind.current === "link"
      ? "Automatic copy is unavailable. Copy the selected card link manually."
      : "Automatic copy is unavailable. Copy the selected report text manually."),
  });
  const busy = imageBusy || clipboard.pending;
  const setCopyInputRef = useCallback((node: HTMLTextAreaElement | null) => { clipboard.inputRef.current = node; }, [clipboard.inputRef]);
  const dismissCopyFallback = () => {
    clipboard.clear(); setStatus("");
    (copyKind.current === "link" ? linkButton : copyButton).current?.focus();
  };
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setImageBusy(false); }, [scope]);
  const filterNote = reportFilterLabel(filters);
  useEffect(() => { try { if (canvas.current) drawReportCard(canvas.current, model, filterNote ? `Filtered: ${filterNote}` : null); setStatus(""); } catch { setStatus("PNG previews are unavailable in this browser. You can still copy the text."); } }, [model, filterNote]);
  const text = reportSummaryText(report, filters, model);
  const link = reportCardLink(model);
  const linkFallback = clipboard.fallbackText !== null && clipboard.fallbackText === link;
  const empty = !model.totals && !model.matchups.length && !model.opener && !model.macro && model.commander === undefined;
  function copy(kind: "text" | "link", value: string) {
    if (busy) return;
    copyKind.current = kind;
    setStatus(kind === "link" ? "Copying card link." : "Copying report text.");
    void clipboard.copy(value);
  }
  async function deliver(method: "web_share" | "download") {
    if (busy || empty) return;
    const operation = currentScope.current;
    const current = () => active.current && currentScope.current === operation;
    clipboard.clear(); setImageBusy(true); setStatus("");
    try {
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
      if (current()) { setStatus(method === "download" ? "PNG downloaded." : "Report shared."); trackInstantReportShared(method); }
    } catch (error) { if (current()) setStatus(error instanceof DOMException && error.name === "AbortError" ? "Sharing cancelled." : "That action was unavailable. Try Download PNG or copy the text below."); }
    finally { if (current()) setImageBusy(false); }
  }
  function toggle(key: "totals" | "opener" | "macro" | "commander") { setSelection((old) => ({ ...old, [key]: !old[key] })); }
  return <Modal open onClose={onClose} title="Share your report" description="Choose the rows to include. Player names, accounts, individual games and replay files are excluded." size="xl">
    <fieldset disabled={busy} className="mb-4 flex flex-wrap gap-x-5 gap-y-3"><legend className="mb-2 font-semibold">Include in your report card</legend>
      {available.totals ? <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selection.totals} onChange={() => toggle("totals")} />Totals</label> : null}
      {available.matchups.map((row) => { const race = row.label.slice(-1); return <label key={race} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selection.matchups.includes(race)} onChange={() => setSelection((old) => ({ ...old, matchups: old.matchups.includes(race) ? old.matchups.filter((r) => r !== race) : [...old.matchups, race] }))} />{row.label}</label>; })}
      {available.opener ? <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selection.opener} onChange={() => toggle("opener")} />Best opener</label> : null}
      {available.macro ? <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selection.macro} onChange={() => toggle("macro")} />Macro score</label> : null}
      {available.commander === undefined ? null : <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={Boolean(selection.commander)} onChange={() => toggle("commander")} />Commander ID</label>}
    </fieldset>
    <canvas ref={canvas} role="img" aria-label={text} className="h-auto w-full rounded-lg border border-line" />
    <p className="mt-2 text-caption text-text-muted">1200 × 630 PNG · best opener requires at least three games · win/loss bars use decided games.</p>
    <div className="mt-4 flex flex-wrap gap-2">
      <Button disabled={busy || empty} onClick={() => void deliver("web_share")}>Share PNG</Button>
      <Button variant="secondary" disabled={busy || empty} onClick={() => void deliver("download")}>Download PNG</Button>
      <Button ref={copyButton} variant="secondary" disabled={busy || empty} onClick={() => copy("text", text)}>Copy text</Button>
      <Button ref={linkButton} variant="secondary" disabled={!link} aria-disabled={busy || !link}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        onClick={() => { if (link) copy("link", link); }}>Copy card link</Button>
    </div>
    {!empty && !link ? <p className="mt-2 text-caption text-text-muted">The selected rows cannot be shared as a link. Change the selection or share the PNG.</p> : null}
    <p role="status" className="mt-3 text-caption text-text-muted">{empty ? "Select at least one row." : status}</p>
    {clipboard.fallbackText !== null ? <div className="mt-3 space-y-2 rounded-lg border border-line bg-bg-surface p-3">
      <label htmlFor={copyInputId} className="block text-caption font-semibold">{linkFallback ? "Copy card link manually" : "Copy report text manually"}</label>
      <textarea ref={setCopyInputRef} id={copyInputId} value={clipboard.fallbackText} readOnly rows={4} aria-describedby={copyHelpId}
        className="block min-h-11 w-full rounded-lg border-2 border-line bg-bg-surface px-3 py-2 text-body text-text focus:outline-none focus:ring-2 focus:ring-accent"
        onFocus={event => event.currentTarget.select()} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismissCopyFallback(); } }} />
      <p id={copyHelpId} className="text-caption text-text-muted">Press Ctrl+C or ⌘C, or use your browser&apos;s Copy command.</p>
      <Button variant="ghost" onClick={dismissCopyFallback}>Done</Button>
    </div> : null}
    <details className="mt-3"><summary tabIndex={0} className="min-h-11 cursor-pointer font-semibold">Report text</summary><pre className="whitespace-pre-wrap break-words text-caption">{text}</pre></details>
  </Modal>;
}
