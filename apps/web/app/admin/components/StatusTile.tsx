import { CheckCircle2, AlertTriangle, XCircle, MinusCircle } from "lucide-react";
import { Card } from "@/components/ui/Card";

export type Tone = "ok" | "warning" | "error" | "neutral";

export function StatusTile({
  label,
  tone,
  primary,
  secondary,
  notes = [],
}: {
  label: string;
  tone: Tone;
  primary: string;
  secondary?: string;
  /** Extra caption lines under `secondary` (hidden when empty). */
  notes?: ReadonlyArray<string>;
}) {
  const dot = {
    ok: "bg-success shadow-[0_0_0_4px_rgba(34,197,94,0.15)]",
    warning: "bg-warning shadow-[0_0_0_4px_rgba(234,179,8,0.15)]",
    error: "bg-danger shadow-[0_0_0_4px_rgba(239,68,68,0.15)]",
    neutral: "bg-text-dim shadow-[0_0_0_4px_rgba(148,163,184,0.12)]",
  }[tone];
  const Icon = { ok: CheckCircle2, warning: AlertTriangle, error: XCircle, neutral: MinusCircle }[tone];
  const status = { ok: "OK", warning: "Warning", error: "Error", neutral: "Disabled" }[tone];
  return (
    <Card padded>
      <div className="flex items-center justify-between">
        <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
          {label}
        </span>
        <Icon className="h-4 w-4" aria-hidden /><span className="sr-only">Status: {status}</span>
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`}
          aria-hidden
        />
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-text">
        {primary}
      </div>
      {secondary ? (
        <p className="mt-1 text-caption text-text-dim">{secondary}</p>
      ) : null}
      {notes.map((note) => (
        <p key={note} className="mt-1 text-caption text-text-dim">
          {note}
        </p>
      ))}
    </Card>
  );
}

