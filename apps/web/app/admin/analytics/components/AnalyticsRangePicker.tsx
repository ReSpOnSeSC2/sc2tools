"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { validateDateRange } from "./analyticsExport";

export function AnalyticsRangePicker({ value, onPreset, onCustom, disabled }: {
  value: number | "custom"; onPreset: (days: number) => void;
  onCustom: (from: string, to: string) => void; disabled?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toLocaleDateString("en-CA");
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-1" role="group" aria-label="Date range">
      {[1, 7, 28, 90, 365].map((days) => <Button key={days} variant="secondary" size="sm" disabled={disabled}
        aria-pressed={!custom && value === days} onClick={() => { setCustom(false); setError(null); onPreset(days); }}>{days}d</Button>)}
      <Button variant="secondary" size="sm" disabled={disabled} aria-pressed={custom || value === "custom"} onClick={() => setCustom(true)}>Custom</Button>
    </div>
    {custom ? <form noValidate className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
      event.preventDefault();
      const problem = validateDateRange(from, to, today);
      setError(problem);
      if (!problem) onCustom(from, to);
    }}>
      <Field label="From"><Input type="date" value={from} max={today} onChange={(event) => setFrom(event.target.value)} /></Field>
      <Field label="To"><Input type="date" value={to} max={today} onChange={(event) => setTo(event.target.value)} /></Field>
      <Button type="submit" variant="secondary" disabled={disabled}>Apply</Button>
      {error ? <p role="alert" className="w-full text-caption text-danger">{error}</p> : null}
    </form> : null}
  </div>;
}
