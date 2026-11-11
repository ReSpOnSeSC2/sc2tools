"use client";

import { formatNumber } from "@/lib/i18n/format";
import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Card, Skeleton } from "@/components/ui/Card";
import { Select } from "@/components/ui/Select";
import { RequestError } from "@/components/ui/RequestError";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import {
  LEAGUES,
  TARGET_METRICS,
  TIMING_ROWS,
  clock,
  formatMetric,
  gapText,
  matchupFromFilters,
  targetRow,
  timingGapText,
  timingRow,
  type LeagueTargetsPrefs,
  type TargetRow,
} from "@/lib/leagueTargets";
import type { ReportDrill } from "../report/types";
import { DecileBar } from "./DecileBar";
import { SeasonGoalPanel } from "./SeasonGoalPanel";
import { useTargetsData } from "./useTargetsData";

const SOURCE_TEXT = { override: "league set by you", replays: "from your latest replay MMR", pulse: "from SC2Pulse" } as const;

/**
 * Targets — where your last 20 ranked games in a matchup sit against your
 * league and the next one: SQ, macro score, APM and game length as decile
 * bars, build-timing gaps, and a season goal estimate. The matchup follows
 * the filter bar when it names one; the league follows your MMR unless you
 * pick one. Every row with a direction opens the games below the target.
 */
export function TargetsCard({ onDrill }: { onDrill: (drill: ReportDrill) => void }) {
  const { getToken } = useAuth();
  const { filters } = useFilters();
  const pinned = matchupFromFilters(filters);
  const [picked, setPicked] = useState<string | null>(null);
  const data = useTargetsData(pinned ?? picked);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ClientApiError | null>(null);
  const t = data.targets.data;

  async function savePrefs(next: LeagueTargetsPrefs) {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await apiCall<LeagueTargetsPrefs>(getToken, "/v1/me/preferences/leagueTargets", { method: "PUT", body: JSON.stringify(next) });
      await data.prefsReq.mutate(saved, { revalidate: false });
    } catch (cause) {
      setSaveError(cause as ClientApiError);
    } finally {
      setSaving(false);
    }
  }

  const bands = data.bands;
  const league = bands ? LEAGUES[bands.current] : null;
  const nextLeague = bands?.next != null ? LEAGUES[bands.next] : null;
  const matchup = data.matchup;
  return (
    <Card title="Targets" headingLevel={2} data-testid="targets-card" id="targets" right={<LazyHelpLink slug="league-targets">Help</LazyHelpLink>}>
      {data.targets.error && !t ? (
        <RequestError title="Couldn't load your targets" error={data.targets.error} onRetry={() => void data.targets.mutate()} />
      ) : !t ? (
        <Skeleton rows={4} />
      ) : !matchup || t.sample.n === 0 ? (
        <p className="text-caption text-text-muted">Play ranked 1v1 games{matchup ? ` in ${matchup}` : ""} to see where you stand against your league and the next one.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            {pinned ? (
              <p className="text-caption text-text-muted">Matchup <strong className="text-text">{matchup}</strong> from your filters</p>
            ) : (
              <label className="flex flex-col gap-1 text-caption text-text-muted">
                Matchup
                <Select value={matchup} onChange={(event) => setPicked(event.target.value)} className="min-h-11">
                  {t.matchups.map((row) => <option key={row.matchup} value={row.matchup}>{row.matchup} ({row.games})</option>)}
                </Select>
              </label>
            )}
            <label className="flex flex-col gap-1 text-caption text-text-muted">
              Compare with
              <Select
                value={data.prefs.leagueOverride === null ? "" : String(data.prefs.leagueOverride)}
                disabled={saving}
                onChange={(event) => void savePrefs({ ...data.prefs, leagueOverride: event.target.value === "" ? null : Number(event.target.value) })}
                className="min-h-11"
              >
                <option value="">My league (automatic)</option>
                {LEAGUES.map((name, id) => <option key={name} value={id}>{name}</option>)}
              </Select>
            </label>
            {bands ? <p className="text-caption text-text-muted">{league} {matchup}, {SOURCE_TEXT[bands.source]}{bands.mmr ? ` (${t.mmr.ladderRace === "R" ? "Random ladder, " : ""}${formatNumber(bands.mmr)} MMR)` : ""}</p> : null}
          </div>
          {saveError ? <RequestError title="Couldn't save your league choice" error={saveError} /> : null}
          {!bands ? (
            <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-caption text-text">
              No MMR yet to place you in a league. Choose your league under <strong>Compare with</strong> to see the bars.
            </p>
          ) : (
            <>
              <p className="text-caption text-text-muted">
                Your median of the last {t.sample.n} ranked {matchup} games (dot) against the {league} range p10–p90 and median (tick){nextLeague ? ` and the ${nextLeague} median (accent tick)` : ""}. Leagues are your opponents&apos; leagues.
              </p>
              <ul className="space-y-3">
                {TARGET_METRICS.map((spec) => {
                  const row = targetRow(spec, t.medians[spec.key], data.currentTable, data.nextTable);
                  return <MetricRow key={spec.key} row={row} league={league!} nextLeague={nextLeague} matchup={matchup} loading={data.tablesLoading} onDrill={onDrill} />;
                })}
              </ul>
              <TimingGaps data={data} league={league!} nextLeague={nextLeague} matchup={matchup} />
            </>
          )}
          <SeasonGoalPanel prefs={data.prefs} currentMmr={data.currentMmr} netMmr={t.netMmr} onSave={(next) => void savePrefs(next)} saving={saving} />
        </div>
      )}
    </Card>
  );
}

function MetricRow({ row, league, nextLeague, matchup, loading, onDrill }: {
  row: TargetRow; league: string; nextLeague: string | null; matchup: string; loading: boolean;
  onDrill: (drill: ReportDrill) => void;
}) {
  const target = row.nextP50 ?? row.currentP50;
  const drillable = row.spec.drillParam !== null && target !== null && row.mine !== null;
  const text = row.state === "no_sample" ? "No measured games yet" : gapText(row, league, nextLeague, matchup);
  const floorNote = loading ? null : row.state === "below_floor"
    ? `Not enough ${league} ${matchup} games yet`
    : nextLeague && row.nextP50 === null && row.mine !== null ? `Not enough ${nextLeague} ${matchup} games yet` : null;
  function drill() {
    if (!drillable || !row.spec.drillParam || target === null) return;
    onDrill({
      title: `${matchup} games below ${formatMetric(row.spec, target)} ${row.spec.unit}`.trim(),
      description: `Ranked 1v1 games under the ${row.nextP50 !== null ? nextLeague : league} median ${row.spec.label.toLowerCase()}, within your current filters.`,
      params: { race: matchup[0], opp_race: matchup[2], map_pool: "ladder", game_size: "1v1", [row.spec.drillParam]: Math.round(target) },
    });
  }
  return (
    <li className="grid gap-1.5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:items-center sm:gap-4">
      <div className="flex items-baseline justify-between gap-2 sm:block">
        <span className="text-body font-medium text-text">{row.spec.label}</span>
        <span className="block text-caption tabular-nums text-text-muted">Yours {formatMetric(row.spec, row.mine)}</span>
      </div>
      <div className="min-w-0 space-y-1">
        <DecileBar deciles={row.deciles} mine={row.mine} currentP50={row.currentP50} nextP50={row.nextP50} label={`${row.spec.label}: ${text}`} />
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-caption">
          <span className="text-text-muted">{text}</span>
          {drillable ? (
            <button type="button" onClick={drill} className="min-h-11 rounded-sm text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              Games below target
            </button>
          ) : null}
        </div>
        {floorNote ? <p className="text-micro text-text-dim">{floorNote}</p> : null}
      </div>
    </li>
  );
}

function TimingGaps({ data, league, nextLeague, matchup }: {
  data: ReturnType<typeof useTargetsData>; league: string; nextLeague: string | null; matchup: string;
}) {
  const mine = data.targets.data?.timings;
  return (
    <section aria-labelledby="timing-gaps-heading" className="space-y-2">
      <h3 id="timing-gaps-heading" className="text-body font-semibold text-text">Timing gaps</h3>
      {!mine || mine.n === 0 ? (
        <p className="text-caption text-text-muted">No build-order timings in your recent ranked {matchup} games.</p>
      ) : (
        <dl className="grid gap-2 sm:grid-cols-2">
          {TIMING_ROWS.map((spec) => {
            const row = timingRow(spec, mine.timings[spec.key], data.currentTimings, data.nextTimings);
            const reference = row.nextP50 ?? row.currentP50;
            const gap = timingGapText(reference !== null && row.mine !== null ? Math.round(row.mine - reference) : null, row.nextP50 !== null ? nextLeague : league);
            const floorLeague = row.nextP50 === null ? nextLeague ?? (row.currentP50 === null ? league : null) : null;
            const floor = floorLeague ? `Not enough ${floorLeague} ${matchup} games yet` : null;
            return (
              <div key={spec.key} className="rounded-lg border border-border p-2">
                <dt className="text-caption text-text-muted">{spec.label} <span className="text-text-dim">({spec.hint})</span></dt>
                <dd className="text-body tabular-nums text-text">
                  {clock(row.mine)}
                  <span className="ml-2 text-caption text-text-muted">
                    {row.mine === null ? "Not reached often enough" : gap ?? floor}
                  </span>
                  {gap && floor ? <span className="block text-micro text-text-dim">{floor}</span> : null}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}
