"use client";

import { useId } from "react";
import { digitsToClock, formatClock, parseClock } from "@/lib/reviews";

type Range = { startSec: number; endSec: number };
export function FocusRangeFields({ start, end, onStartChange, onEndChange, durationSec, range, touched }: {
  start: string; end: string; onStartChange: (value: string) => void; onEndChange: (value: string) => void;
  durationSec: number | null; range: { value: Range | null; error: string | null }; touched: boolean;
}) {
  const id = useId();
  const duration = durationSec !== null && durationSec > 0 ? durationSec : null;
  const chips = [{ name: "Early", start: 0, end: Math.min(300, duration ?? 300) }, { name: "Mid", start: 300, end: Math.min(600, duration ?? 600) }, ...(duration !== null ? [{ name: "Late", start: 600, end: duration }] : [])].filter((chip) => chip.end > chip.start);
  const echo = range.value ? `Focus ${formatClock(range.value.startSec)}–${formatClock(range.value.endSec)}${duration !== null ? ` of ${formatClock(duration)}` : ""}` : !start && !end ? "Whole game" : "";
  const error = touched ? range.error : null;
  return <fieldset>
    <legend className="text-caption font-semibold text-text">Time range of interest (optional)</legend>
    <div className="mt-2 flex flex-wrap gap-1.5">{chips.map((chip) => <button type="button" key={chip.name} aria-pressed={range.value?.startSec === chip.start && range.value?.endSec === chip.end} onClick={() => { onStartChange(formatClock(chip.start)); onEndChange(formatClock(chip.end)); }} className="min-h-10 rounded-full border border-line px-3 text-caption font-semibold text-text hover:bg-bg-elevated aria-pressed:border-accent aria-pressed:bg-accent/10">{chip.name} {formatClock(chip.start)}–{chip.name === "Late" ? "end" : formatClock(chip.end)}</button>)}<button type="button" aria-pressed={!start && !end} onClick={() => { onStartChange(""); onEndChange(""); }} className="min-h-10 rounded-full border border-line px-3 text-caption font-semibold text-text hover:bg-bg-elevated aria-pressed:border-accent aria-pressed:bg-accent/10">Whole game</button></div>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input aria-label="From (m:ss)" aria-invalid={!!error} aria-describedby={`${id}-echo ${id}-start${error ? ` ${id}-error` : ""}`} inputMode="text" autoComplete="off" placeholder="5:00" value={start} onChange={(event) => onStartChange(event.target.value)} className="h-10 w-24 rounded-lg border-2 border-line bg-bg px-2 font-mono text-body" />
      <span className="text-text-dim">to</span>
      <input aria-label="To (m:ss)" aria-invalid={!!error} aria-describedby={`${id}-echo ${id}-end${error ? ` ${id}-error` : ""}`} inputMode="text" autoComplete="off" placeholder="6:30" value={end} onChange={(event) => onEndChange(event.target.value)} className="h-10 w-24 rounded-lg border-2 border-line bg-bg px-2 font-mono text-body" />
      {duration !== null ? <span className="text-micro text-text-dim">Game length {formatClock(duration)}</span> : null}
    </div>
    <p id={`${id}-echo`} aria-live="polite" className="mt-1 text-caption text-text-muted">{echo}</p>
    <DigitSuggestion id={`${id}-start`} raw={start} onChoose={onStartChange} />
    <DigitSuggestion id={`${id}-end`} raw={end} onChoose={onEndChange} />
    {error ? <p id={`${id}-error`} role="alert" className="mt-1 text-micro text-danger">{error}</p> : null}
  </fieldset>;
}

function DigitSuggestion({ raw, id, onChoose }: { raw: string; id: string; onChoose: (value: string) => void }) {
  const suggestion = digitsToClock(raw);
  const seconds = parseClock(raw);
  if (!suggestion || seconds === null || seconds === parseClock(suggestion)) return <span id={id} />;
  return <p id={id} className="mt-1 text-caption text-text-muted">{raw.trim()} reads as {formatClock(seconds)} (seconds). Did you mean {suggestion}? <button type="button" className="inline-flex min-h-10 items-center font-semibold text-link hover:underline" onClick={() => onChoose(suggestion)}>Use {suggestion}</button></p>;
}
