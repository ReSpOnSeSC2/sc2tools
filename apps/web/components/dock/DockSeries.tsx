"use client";

import { useEffect, useId, useRef, useState } from "react";
import { HelpCircle, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { API_BASE, boundedApiRequest } from "@/lib/clientApi";
import type { LiveGameEnvelope } from "@/components/overlay/types";
import { SeriesScoreboard } from "@/components/overlay/widgets/SeriesWidget";
import { DockButton } from "./DockControls";
import { useSeriesController } from "./useSeriesController";
import styles from "./DockSeries.module.css";

export function DockSeries({ token, rawEvent, live, lastOpponent, onInvalid, onSummary }: {
  token: string; rawEvent?: unknown; live: LiveGameEnvelope | null; lastOpponent?: string | null;
  onInvalid: (replaced?: boolean) => void; onSummary?: (summary: string, active: boolean) => void;
}) {
  const state = useSeriesController(token, rawEvent, onInvalid), id = useId();
  const [name, setName] = useState(""), [opponentToon, setToon] = useState<string | null>(null);
  const [format, setFormat] = useState(3), [maps, setMaps] = useState(""), [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<"start" | "end" | null>(null), [poolBusy, setPoolBusy] = useState(false);
  const edited = useRef(false), alive = useRef(true), pool = useRef<AbortController | null>(null);
  const mapsRef = useRef(maps); mapsRef.current = maps;
  useEffect(() => { alive.current = true; return () => { alive.current = false; pool.current?.abort(); }; }, []);
  useEffect(() => {
    if (edited.current) return;
    const known = state.series?.opponentName || live?.opponent?.name || lastOpponent;
    if (known) { setName(known); setToon(state.series ? null : live?.opponent?.toonHandle ?? null); }
    if (state.series) { setFormat(state.series.format); setMaps(state.series.maps.join("\n")); }
  }, [state.series, live?.opponent?.name, live?.opponent?.toonHandle, lastOpponent]);
  const series = state.series;
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 3000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { onSummary?.(series ? `Bo${series.format} · ${series.score.you}–${series.score.opponent} · ${series.status}` : "No active series", series?.status === "active" || series?.status === "paused"); }, [series, onSummary]);
  const save = async (action: "start" | "end") => {
    const saved = await state.act(action === "start" ? { action, opponentName: name.trim(), ...(opponentToon ? { opponentToon } : {}), format, maps: maps.split(/\r?\n/u).map(value => value.trim()).filter(Boolean) } : { action });
    if (saved && alive.current) { setConfirm(null); setNotice(action === "start" ? "Series started" : "Series ended"); }
  };
  const loadPool = async () => {
    if (pool.current) return;
    const controller = new AbortController(), captured = mapsRef.current; pool.current = controller; setPoolBusy(true);
    try {
      const rows = await boundedApiRequest(async signal => {
        const response = await fetch(`${API_BASE}/v1/seasons`, { signal, cache: "no-store" });
        if (!response.ok) throw new Error("Map pool unavailable");
        const raw = await response.json(); return raw?.mapPool;
      }, 20_000, controller.signal);
      if (alive.current && !controller.signal.aborted && Array.isArray(rows)) {
        const choices = rows.filter((value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100).slice(0, 20);
        if (!choices.length) throw new Error("No current map pool");
        if (mapsRef.current !== captured) { setNotice("Your newer map draft was kept. Load the pool again to replace it."); return; }
        edited.current = true; setMaps(choices.join("\n")); setNotice("Map pool filled. Reorder the lines for your series.");
      }
    } catch { if (alive.current && !controller.signal.aborted) setNotice("Couldn't load the map pool. Type the map order below."); }
    finally { if (pool.current === controller) { pool.current = null; if (alive.current) setPoolBusy(false); } }
  };
  const adjust = async (side: "you" | "opponent", delta: number) => { if (await state.act({ action: "adjust", side, delta }) && alive.current) setNotice("Series score saved"); };
  const disabled = !state.ready || state.busy, needed = series ? Math.ceil(series.format / 2) : 1;
  return <div className={`${styles.root} min-w-0 space-y-4 text-caption`}>
    <div className="space-y-2 text-text-muted"><p className="flex items-start gap-2"><HelpCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span>Best-of scoreboard for cups and showmatches.</span></p><LazyHelpLink slug="series-mode">How Series works</LazyHelpLink></div>
    {series ? <><SeriesScoreboard series={series} />
      <div className={styles.scoreControls}>{(["you", "opponent"] as const).map(side => <div key={side} className="min-w-0 space-y-1"><p>{side === "you" ? "Your score" : "Opponent score"}</p><div className="grid grid-cols-2 gap-2">
        <DockButton aria-label={`Remove a win for ${side === "you" ? "you" : "opponent"}`} disabled={disabled || series.status === "ended" || series.score[side] === 0} onClick={() => void adjust(side, -1)}>−1</DockButton>
        <DockButton aria-label={`Add a win for ${side === "you" ? "you" : "opponent"}`} disabled={disabled || series.status === "ended" || series.score[side] >= needed || series.score[side === "you" ? "opponent" : "you"] === needed} onClick={() => void adjust(side, 1)}>+1</DockButton>
      </div></div>)}</div>
      {series.status === "paused" ? <p role="status" className="text-warning">80 replay receipts retained. Automatic scoring is paused; correct the score manually, then End or start a new series.</p> : null}
    </> : <p className="text-text-muted">{state.ready ? "No series started. Normal ladder widgets keep their own session." : "Loading Series…"}</p>}
    {state.error ? <p role="alert" className="text-danger">{state.error}</p> : null}
    <div className="flex flex-wrap gap-2">
      {series && series.status !== "ended" ? <DockButton disabled={disabled} onClick={() => setConfirm("end")}>End series</DockButton> : null}
      <DockButton disabled={state.busy} onClick={() => void state.refresh()}><RefreshCw className="h-4 w-4" aria-hidden />Refresh series</DockButton>
    </div>
    <fieldset disabled={state.busy} className="min-w-0 space-y-3 border-t border-border pt-3">
      <legend className="font-semibold">{series ? "Start a new series" : "New series"}</legend>
      <label className="block" htmlFor={`${id}-opponent`}>Opponent<Input id={`${id}-opponent`} value={name} maxLength={80} onChange={event => { edited.current = true; setName(event.target.value); setToon(null); }} /></label>
      <label className="block" htmlFor={`${id}-format`}>Format<Select id={`${id}-format`} value={format} onChange={event => { edited.current = true; setFormat(Number(event.target.value)); }}>{[1, 3, 5, 7].map(value => <option key={value} value={value}>Best of {value}</option>)}</Select></label>
      <label className="block" htmlFor={`${id}-maps`}>Map order · optional<textarea id={`${id}-maps`} value={maps} maxLength={2020} rows={3} className="mt-1 w-full resize-y rounded-md border border-border bg-bg-surface p-2 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" placeholder="One map per line" onChange={event => { edited.current = true; setMaps(event.target.value); }} /></label>
      <div className="flex flex-wrap gap-2"><DockButton disabled={poolBusy} onClick={() => void loadPool()}>{poolBusy ? "Loading maps…" : "Use current map pool"}</DockButton><DockButton disabled={disabled || !name.trim()} onClick={() => series && series.status !== "ended" ? setConfirm("start") : void save("start")}>Start series</DockButton></div>
    </fieldset>
    <p className="text-text-muted">Only matching replays that started after Start count. Older uploads without an exact start need manual scoring. Ties do not add wins. Manual −1 can correct a completed score.</p>
    {notice ? <p role="status">{notice}</p> : null}
    <ConfirmDialog open={confirm !== null} focusCancel loading={state.busy} onClose={() => { if (!state.busy) setConfirm(null); }} onConfirm={() => confirm && void save(confirm)} title={confirm === "end" ? "End this series?" : "Replace the current series?"} confirmLabel={confirm === "end" ? "End series" : "Start new series"} description={confirm === "end" ? "Stop automatic scoring. The final score remains available until your next Start." : "Reset this token's score and replay receipts. Other tokens keep their series."} />
  </div>;
}
