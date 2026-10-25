"use client";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { parseBuildOrderText } from "@/lib/buildOrderText";
import type { ReferenceBuildOrder } from "@/lib/buildOrderReference";

export function BuildOrderPaste({ race, onImport, disabled = false }: { race?: string; onImport: (value: ReferenceBuildOrder) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const parsed = useMemo(() => parseBuildOrderText(text, { race }), [text, race]);
  return <div className="space-y-3">
    <label className="block space-y-1 text-caption">Paste a build order<textarea aria-label="Paste a build order" disabled={disabled} value={text} maxLength={64001} rows={6} onChange={event => setText(event.target.value)} className="block w-full min-w-0 rounded-lg border border-border bg-bg-surface p-3 font-mono text-caption text-text" placeholder={"13 0:18 Pylon\n14 - Gateway\n[1:30] Cybernetics Core"} /></label>
    <details className="text-caption"><summary className="inline-flex min-h-11 cursor-pointer items-center font-medium">Supported formats</summary><p className="text-text-muted">Use [0:18] Pylon, 13 0:18 Pylon, 14 - Pylon, or 0:18 Pylon. Supply-only rows keep an unknown time. Up to 120 nonempty lines.</p><LazyHelpLink slug="build-order-paste">Formats and examples</LazyHelpLink></details>
    {text.trim() ? <div className="space-y-2" aria-label="Paste preview"><p className="text-caption">{parsed.steps.length} steps parsed. Unknown actions remain reference text.</p><ul className="max-h-40 space-y-1 overflow-auto text-caption">{parsed.issues.map((issue, index) => <li key={index} className={issue.kind === "error" ? "text-danger" : "text-text-muted"}>Line {issue.line} · {issue.kind === "error" ? "Fix" : "Warning"}: {issue.message}</li>)}</ul><ol className="max-h-48 space-y-1 overflow-auto text-caption">{parsed.steps.map((step, index) => <li key={index}>{step.t === null ? "Time unknown" : `${Math.floor(step.t / 60)}:${String(step.t % 60).padStart(2, "0")}`} · {step.supply ?? "Supply unknown"} · {step.action}</li>)}</ol></div> : null}
    <Button disabled={disabled || !parsed.order} onClick={() => { if (parsed.order) onImport(parsed.order); }}>Use pasted order</Button>
  </div>;
}
