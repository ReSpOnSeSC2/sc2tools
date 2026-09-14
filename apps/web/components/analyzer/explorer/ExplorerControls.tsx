"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import type { ExplorerControls, ExplorerPlayer, ExplorerResponse, ExplorerView } from "@/lib/trendsExplorer";
import { ACTION_CLASS, CONTROL_CLASS, ExplorerField, formatCount } from "./ExplorerPrimitives";

function dateAtOffset(days: number, now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function periodControls(days: number): ExplorerControls {
  return { a_since: dateAtOffset(-days * 2), a_until: dateAtOffset(-days - 1), b_since: dateAtOffset(-days), b_until: dateAtOffset(-1) };
}

export function initialExplorerControls(): Record<ExplorerView, ExplorerControls> {
  return {
    "mmr-gap": { gap_width: 200 },
    periods: periodControls(28),
    groups: { group_mode: "mmr", a_min: 3500, a_max: 4500, b_min: 4500, b_max: 5500, weight: "games" },
    execution: { milestone: "third-base", interval: "auto" },
    leads: { checkpoint: 300, metric: "workers" },
    breaks: { after: "all" },
    rematches: { after: "all" },
  };
}

export function validateExplorerControls(view: ExplorerView, values: ExplorerControls): string | null {
  if (view === "periods") {
    for (const group of ["a", "b"]) {
      const start = String(values[`${group}_since`] ?? "");
      const end = String(values[`${group}_until`] ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return "Choose a start and end date for both periods.";
      if (start > end) return "Each start date must be on or before its end date.";
    }
  }
  if (view === "groups" && values.group_mode === "mmr") {
    for (const group of ["a", "b"]) {
      const min = values[`${group}_min`];
      const max = values[`${group}_max`];
      if (min !== "" && min !== undefined && (!Number.isInteger(Number(min)) || Number(min) < 0 || Number(min) > 10000)) return "Minimum MMR must be a whole number between 0 and 10,000.";
      if (max !== "" && max !== undefined && (!Number.isInteger(Number(max)) || Number(max) < 0 || Number(max) > 10001)) return "Upper MMR bound must be a whole number between 0 and 10,001.";
      if (min !== "" && min !== undefined && max !== "" && max !== undefined && Number(min) >= Number(max)) return "Each upper MMR bound must be greater than its lower bound.";
    }
  }
  if (view === "groups" && values.group_mode === "players" && (!values.a_players || !values.b_players)) return "Choose at least one account in each group.";
  return null;
}

export function ExplorerPanelControls({ view, values, onChange, options, isGlobal }: {
  view: ExplorerView; values: ExplorerControls; onChange: (next: ExplorerControls) => void; options?: ExplorerResponse["options"]; isGlobal: boolean;
}) {
  const [draft, setDraft] = useState(values);
  const [attempted, setAttempted] = useState(false);
  const set = (key: string, value: string | number) => setDraft((current) => ({ ...current, [key]: value }));
  const error = validateExplorerControls(view, draft);
  const changed = JSON.stringify(draft) !== JSON.stringify(values);
  const apply = () => { setAttempted(true); if (!error) onChange(draft); };

  if (view === "mmr-gap") return <div className="max-w-sm"><ExplorerField label="MMR difference band" hint="Negative: lower-rated opponent. Positive: higher-rated opponent."><select className={CONTROL_CLASS} value={String(values.gap_width)} onChange={(e) => onChange({ ...values, gap_width: Number(e.target.value) })}>{[100, 200, 500].map((n) => <option value={n} key={n}>{n} MMR</option>)}</select></ExplorerField></div>;
  if (view === "leads") return <div className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
    <ExplorerField label="Checkpoint"><select className={CONTROL_CLASS} value={String(values.checkpoint)} onChange={(e) => onChange({ ...values, checkpoint: Number(e.target.value) })}>{[300, 480, 720].map((n) => <option value={n} key={n}>{n / 60} minutes</option>)}</select></ExplorerField>
    <ExplorerField label="Advantage measured by"><select className={CONTROL_CLASS} value={String(values.metric)} onChange={(e) => onChange({ ...values, metric: e.target.value })}><option value="workers">Worker count</option><option value="army">Army value</option></select></ExplorerField>
  </div>;
  if (view === "breaks" || view === "rematches") return <div className="max-w-xs"><ExplorerField label={view === "rematches" ? "Previous encounter result" : "Previous game result"}><select className={CONTROL_CLASS} value={String(values.after)} onChange={(e) => onChange({ ...values, after: e.target.value })}><option value="all">After any result</option><option value="loss">After a loss</option><option value="win">After a win</option></select></ExplorerField></div>;
  if (view === "execution") {
    const milestones = options?.milestones?.length ? options.milestones : [{ id: "third-base", label: "Third base" }];
    return <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <ExplorerField label="Execution milestone"><select className={CONTROL_CLASS} value={String(values.milestone)} onChange={(e) => onChange({ ...values, milestone: e.target.value })}>{milestones.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></ExplorerField>
      <ExplorerField label="Build"><select className={CONTROL_CLASS} value={String(values.build ?? "")} onChange={(e) => onChange({ ...values, build: e.target.value || undefined })}><option value="">Use page build filter</option>{(options?.builds ?? []).map((build) => <option key={build} value={build}>{build}</option>)}</select></ExplorerField>
      <ExplorerField label="Timing period"><select className={CONTROL_CLASS} value={String(values.interval ?? "auto")} onChange={(e) => onChange({ ...values, interval: e.target.value })}><option value="auto">Automatic</option><option value="week">Week</option><option value="month">Month</option></select></ExplorerField>
    </div>;
  }

  return <div className="space-y-4">
    {view === "periods" ? <>
      <div className="flex flex-wrap items-center gap-2 text-xs"><span className="mr-1 text-text-dim">Quick comparison</span>{[28, 90].map((days) => <button type="button" key={days} className={ACTION_CLASS} onClick={() => { const next = periodControls(days); setDraft(next); setAttempted(false); onChange(next); }}>Last {days} days vs previous</button>)}</div>
      <div className="grid gap-3 lg:grid-cols-2">{(["a", "b"] as const).map((group) => <fieldset key={group} className="min-w-0 rounded-xl border border-border p-3"><legend className="px-1 text-xs font-semibold text-text">Period {group.toUpperCase()}</legend><div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ExplorerField label={`Period ${group.toUpperCase()} start`}><input type="date" className={CONTROL_CLASS} value={String(draft[`${group}_since`] ?? "")} onChange={(e) => set(`${group}_since`, e.target.value)} /></ExplorerField>
        <ExplorerField label={`Period ${group.toUpperCase()} end`}><input type="date" className={CONTROL_CLASS} value={String(draft[`${group}_until`] ?? "")} onChange={(e) => set(`${group}_until`, e.target.value)} /></ExplorerField>
      </div></fieldset>)}</div>
      <p className="text-xs leading-relaxed text-text-dim">Dates include both endpoints in UTC. These two periods replace the page date range for this analysis; every other page filter still applies.</p>
    </> : <>
      <div className="grid gap-3 sm:grid-cols-2">
        <ExplorerField label="Compare by"><select className={CONTROL_CLASS} value={String(draft.group_mode)} onChange={(e) => set("group_mode", e.target.value)}><option value="mmr">Game-time player MMR</option><option value="players">Selected player accounts</option></select></ExplorerField>
        <ExplorerField label="Weight results"><select className={CONTROL_CLASS} value={String(draft.weight)} onChange={(e) => set("weight", e.target.value)}><option value="games">Every game equally</option><option value="players">Every player equally</option></select></ExplorerField>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">{(["a", "b"] as const).map((group) => <fieldset key={group} className="min-w-0 rounded-xl border border-border p-3"><legend className="px-1 text-xs font-semibold text-text">Group {group.toUpperCase()}</legend>
        {draft.group_mode === "players" ? <PlayerPicker group={group} players={options?.players ?? []} value={String(draft[`${group}_players`] ?? "")} onChange={(value) => set(`${group}_players`, value)} /> : <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ExplorerField label={`Group ${group.toUpperCase()} minimum MMR`}><input type="number" min={0} step={100} inputMode="numeric" placeholder="No minimum" className={CONTROL_CLASS} value={String(draft[`${group}_min`] ?? "")} onChange={(e) => set(`${group}_min`, e.target.value)} /></ExplorerField>
          <ExplorerField label={`Group ${group.toUpperCase()} upper MMR bound`}><input type="number" min={0} step={100} inputMode="numeric" placeholder="No maximum" className={CONTROL_CLASS} value={String(draft[`${group}_max`] ?? "")} onChange={(e) => set(`${group}_max`, e.target.value)} /></ExplorerField>
        </div>}
      </fieldset>)}</div>
      <p className="text-xs leading-relaxed text-text-dim">{draft.group_mode === "players" ? isGlobal ? "Accounts come from the selected player population above. A player can belong to both groups." : "Choose among the accounts in your uploaded history. A player can belong to both groups." : "MMR ranges use each player’s rating recorded for that game. The upper bound is excluded. Games without a recorded rating are excluded."} {draft.weight === "players" ? "Win rate averages each player’s win rate, so frequent uploaders carry the same weight as other players." : "Win rate uses the combined wins and losses in each group."}</p>
    </>}
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div aria-live="polite" className={`text-xs ${attempted && error ? "text-danger" : "text-text-dim"}`}>{attempted && error ? error : changed ? "Unapplied changes" : "Comparison settings applied"}</div>
      <button type="button" onClick={apply} disabled={!changed} className={`${ACTION_CLASS} shrink-0`}>Apply comparison</button>
    </div>
  </div>;
}

function PlayerPicker({ group, players, value, onChange }: { group: "a" | "b"; players: ExplorerPlayer[]; value: string; onChange: (value: string) => void }) {
  const [search, setSearch] = useState("");
  const selected = new Set(value.split(",").filter(Boolean));
  const matches = players.filter((player) => `${player.label} ${player.id}`.toLowerCase().includes(search.toLowerCase()));
  const toggle = (id: string) => { const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id); onChange(Array.from(next).join(",")); };
  return <div className="min-w-0 space-y-2">
    <label className="relative block"><span className="sr-only">Search group {group.toUpperCase()} accounts</span><Search aria-hidden className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-text-dim" /><input type="search" className={`${CONTROL_CLASS} pl-9`} placeholder="Search name or account…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
    <div className="flex flex-wrap items-center justify-between gap-x-2 text-xs"><span className="text-text-muted">{selected.size} selected</span><div className="flex gap-1"><button type="button" className="min-h-11 rounded px-2 font-medium text-accent hover:bg-accent/10" onClick={() => onChange(Array.from(new Set([...selected, ...matches.map((p) => p.id)])).join(","))}>Select visible</button><button type="button" className="min-h-11 rounded px-2 font-medium text-text-muted hover:bg-bg-elevated" onClick={() => onChange("")}>Clear</button></div></div>
    <div className="max-h-56 overflow-y-auto overscroll-contain rounded-lg border border-border" aria-label={`Group ${group.toUpperCase()} player accounts`}>
      {matches.length ? matches.map((player) => <label key={player.id} className="flex min-h-14 cursor-pointer items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-bg-elevated"><input type="checkbox" className="h-4 w-4 shrink-0 accent-accent" checked={selected.has(player.id)} onChange={() => toggle(player.id)} /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-text" title={player.label}>{player.label}</span><span className="block truncate text-[10px] text-text-dim" title={player.id}>{player.id}</span></span><span className="shrink-0 text-[11px] tabular-nums text-text-muted">{player.currentMmr == null ? "MMR —" : `${formatCount(player.currentMmr)} MMR`}</span></label>) : <p className="p-4 text-center text-xs text-text-dim">{players.length ? "No accounts match your search." : "No player accounts available for this selection."}</p>}
    </div>
  </div>;
}
