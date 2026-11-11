"use client";

import { formatNumber } from "@/lib/i18n/format";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { rollUpSeasons, useSeasons } from "@/lib/useSeasons";
import { LEAGUES, LEAGUE_MIN_MMR, seasonEstimate, type LeagueTargetsPrefs, type TargetsResponse } from "@/lib/leagueTargets";

/**
 * Season goal: a target league or MMR (saved in preferences), how far it is,
 * the average net MMR per game over the last 30 games, and the plain
 * arithmetic to the season end. Always labelled as an estimate.
 */
export function SeasonGoalPanel({ prefs, currentMmr, netMmr, onSave, saving }: {
  prefs: LeagueTargetsPrefs;
  currentMmr: number | null;
  netMmr: TargetsResponse["netMmr"] | null;
  onSave: (next: LeagueTargetsPrefs) => void;
  saving: boolean;
}) {
  const seasons = useSeasons();
  const current = rollUpSeasons(seasons.data?.items).find((s) => s.isCurrent) ?? null;
  const [customMmr, setCustomMmr] = useState(prefs.targetMmr ? String(prefs.targetMmr) : "");
  const mode = prefs.targetMmr !== null ? "mmr" : prefs.targetLeague !== null ? String(prefs.targetLeague) : "";
  const estimate = seasonEstimate({ currentMmr, prefs, perGame: netMmr?.perGame, seasonEnd: current?.end ?? null, now: Date.now() });

  function chooseMode(value: string) {
    if (value === "") onSave({ ...prefs, targetLeague: null, targetMmr: null });
    else if (value === "mmr") {
      const mmr = Number(customMmr) || (currentMmr ? Math.ceil((currentMmr + 200) / 50) * 50 : 4000);
      setCustomMmr(String(mmr));
      onSave({ ...prefs, targetLeague: null, targetMmr: mmr });
    } else onSave({ ...prefs, targetLeague: Number(value), targetMmr: null });
  }

  function saveCustom() {
    const mmr = Number(customMmr);
    if (Number.isInteger(mmr) && mmr >= 1 && mmr <= 8000 && mmr !== prefs.targetMmr) onSave({ ...prefs, targetLeague: null, targetMmr: mmr });
  }

  return (
    <section aria-labelledby="season-goal-heading" className="space-y-3 rounded-lg border border-border bg-bg-elevated p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="season-goal-heading" className="text-body font-semibold text-text">Season goal</h3>
        <Badge variant="neutral" size="sm">Estimate</Badge>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Target" className="min-w-0">
          <Select value={mode} onChange={(event) => chooseMode(event.target.value)} disabled={saving} className="min-h-11">
            <option value="">No target</option>
            {LEAGUES.map((name, id) => <option key={name} value={id}>{name} ({formatNumber(LEAGUE_MIN_MMR[id])}+ MMR)</option>)}
            <option value="mmr">An MMR…</option>
          </Select>
        </Field>
        {mode === "mmr" ? (
          <Field label="MMR">
            <Input type="number" inputMode="numeric" min={1} max={8000} step={10} value={customMmr} disabled={saving}
              onChange={(event) => setCustomMmr(event.target.value)} onBlur={saveCustom}
              onKeyDown={(event) => { if (event.key === "Enter") saveCustom(); }} className="w-28" />
          </Field>
        ) : null}
      </div>
      <SeasonEstimateText estimate={estimate} netMmr={netMmr} currentMmr={currentMmr} seasonKnown={!!current?.end} />
    </section>
  );
}

function SeasonEstimateText({ estimate, netMmr, currentMmr, seasonKnown }: {
  estimate: ReturnType<typeof seasonEstimate>;
  netMmr: TargetsResponse["netMmr"] | null;
  currentMmr: number | null;
  seasonKnown: boolean;
}) {
  if (estimate.state === "no_target") return <p className="text-caption text-text-muted">Pick a league or an MMR to see how many games it could take.</p>;
  if (estimate.state === "no_mmr") return <p className="text-caption text-text-muted">No current MMR yet: play a rated game, or add your Pulse ID in Settings.</p>;
  const trend = netMmr?.perGame != null
    ? `Average net ${netMmr.perGame > 0 ? "+" : ""}${netMmr.perGame} MMR per game over your last ${netMmr.games} games (${netMmr.pairs} measured).`
    : "Not enough consecutive rated games to measure your net MMR per game yet.";
  return (
    <dl className="grid gap-2 text-caption sm:grid-cols-2">
      <div><dt className="text-text-dim">Now → target</dt><dd className="tabular-nums text-text">{currentMmr == null ? "—" : formatNumber(currentMmr)} → {formatNumber(estimate.target)} MMR</dd></div>
      <div><dt className="text-text-dim">MMR to go</dt><dd className="tabular-nums text-text">{estimate.state === "reached" ? "Reached" : formatNumber(estimate.mmrToGo)}</dd></div>
      <div className="sm:col-span-2"><dt className="sr-only">Recent pace</dt><dd className="text-text-muted">{trend}</dd></div>
      {estimate.state === "estimate" ? (
        <div className="sm:col-span-2"><dt className="sr-only">Estimated games</dt><dd className="text-text">
          About {formatNumber(estimate.games)} games at that pace
          {estimate.perWeek !== null && estimate.weeksLeft !== null
            ? `: roughly ${formatNumber(estimate.perWeek)} a week for the ${estimate.weeksLeft} weeks left this season.`
            : seasonKnown ? "; the season ends before then." : ". The season's end date isn't known yet."}
        </dd></div>
      ) : estimate.state === "no_trend" ? (
        <div className="sm:col-span-2"><dt className="sr-only">Estimated games</dt><dd className="text-text-muted">No estimate while the average is flat or falling.</dd></div>
      ) : null}
    </dl>
  );
}
