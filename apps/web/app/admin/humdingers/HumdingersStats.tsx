"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RequestError } from "@/components/ui/RequestError";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { useApi } from "@/lib/clientApi";
import { formatDate, formatDateTime, formatNumber } from "@/lib/i18n/format";
import { AdminDate } from "../components/AdminDate";
import { AdminPageHeader } from "../components/AdminPageHeader";
import { ForbiddenCard, LoadingRows, MetricStat } from "../components/AdminFragments";

type Range = "7" | "30" | "90";
type DayRow = { day: string; loads: number; players: number; activeSeconds: number; longPlays: number; savers: number; maxChapter: number };
type SessionRow = { startedAt: string; lastAt: string; activeSeconds: number; maxChapter: number; saved: boolean };
export type HumdingersPlayer = {
  userId: string;
  displayName: string | null;
  battleTag: string | null;
  email: string | null;
  sessions: number;
  activeSeconds: number;
  lastAt: string | null;
  maxChapter: number;
  save: { slots: number; playtime: number; chapter: number; savedAt: string | null } | null;
  recent: SessionRow[];
};
export type HumdingersStatsResp = {
  days: number;
  totals: { loads: number; playerDays: number; activeSeconds: number; longPlays: number; savers: number; maxChapter: number };
  daily: DayRow[];
  /** Missing only from an API older than ADR 0103. */
  players?: HumdingersPlayer[];
  playersTruncated?: boolean;
};

const RANGES: ReadonlyArray<SegmentedOption<Range>> = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];
/** The day the API started keeping play sessions with accounts (ADR 0103). */
const SESSIONS_SINCE = "2026-11-27";
const CELL = "py-2 pr-3";
const NUMBER_CELL = `${CELL} text-right tabular-nums`;

/**
 * /admin/humdingers — plays of the Humdingers browser RPG: the accounts that
 * played, each with their play sessions and saves (ADR 0103), plus the
 * anonymous daily totals of loads, players, active play time and progress
 * (ADR 0102).
 */
export function HumdingersStats() {
  const [range, setRange] = useState<Range>("30");
  const swr = useApi<HumdingersStatsResp>(`/v1/admin/humdingers/stats?days=${range}`, { keepPreviousData: true, revalidateOnFocus: false });
  if (swr.error?.status === 403 || swr.error?.status === 401) return <ForbiddenCard />;
  const data = swr.data;
  const players = data?.players ?? [];
  const dailyRows = data ? data.daily.filter((row) => row.loads > 0 || row.activeSeconds > 0) : [];

  return (
    <div className="space-y-6">
      <AdminPageHeader anchor="humdingers-plays" title="Humdingers"
        description="Who plays the browser RPG at /play/humdingers and for how long, with daily totals."
        actions={<SegmentedControl label="Range" value={range} options={RANGES} onChange={setRange} />} />
      {swr.error ? <RequestError error={swr.error} onRetry={() => void swr.mutate()} /> : !data ? <LoadingRows rows={4} /> : (
        <>
          <Totals totals={data.totals} />
          {data.totals.loads === 0 && players.length === 0 ? (
            <Card padded><EmptyStatePanel title="No plays yet"
              description={`Nobody opened Humdingers in the last ${data.days} days. Plays appear here the same day.`} /></Card>
          ) : (
            <>
              <PlayersCard players={players} truncated={data.playersTruncated === true} days={data.days} />
              {dailyRows.length ? <DailyTable rows={dailyRows} /> : null}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Totals({ totals }: { totals: HumdingersStatsResp["totals"] }) {
  const perPlayer = totals.playerDays ? Math.round(totals.activeSeconds / totals.playerDays) : 0;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <MetricStat label="Plays" value={formatNumber(totals.loads)} caption="Times the game was opened" />
      <MetricStat label="Daily players" value={formatNumber(totals.playerDays)} caption="Players each day, added up" />
      <MetricStat label="Play time" value={duration(totals.activeSeconds)} caption="Active play; idle time left out" />
      <MetricStat label="Per daily player" value={duration(perPlayer)} caption="Average play time" />
      <MetricStat label="Played over a minute" value={formatNumber(totals.longPlays)} caption={`${formatNumber(totals.savers)} daily players had a save`} />
      <MetricStat label="Furthest chapter" value={totals.maxChapter ? formatNumber(totals.maxChapter) : "None yet"} caption="From players' saves" />
    </div>
  );
}

function PlayersCard({ players, truncated, days }: { players: HumdingersPlayer[]; truncated: boolean; days: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const since = formatDate(`${SESSIONS_SINCE}T00:00:00Z`, { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
  return (
    <Card title={`Players (${formatNumber(players.length)}${truncated ? "+" : ""})`} headingLevel={2}>
      <p className="text-caption text-text-muted">
        Accounts that played in the last {days} days, most recent first. Open a player&apos;s sessions to see each visit.
        Sessions are recorded from {since} and kept for 90 days; the game clock is the play time in the account&apos;s saves.
        {truncated ? " Only the 200 most recent players are listed." : ""}
      </p>
      {players.length === 0 ? (
        <p className="mt-3 text-caption text-text">No player sessions in this range yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-caption">
            <caption className="sr-only">Humdingers players</caption>
            <thead className="text-text-dim">
              <tr>
                <th scope="col" className={`${CELL} font-semibold`}>Player</th>
                <th scope="col" className={`${NUMBER_CELL} font-semibold`}>Sessions</th>
                <th scope="col" className={`${NUMBER_CELL} font-semibold`}>Play time</th>
                <th scope="col" className={`${CELL} font-semibold`}>Last played</th>
                <th scope="col" className={`${NUMBER_CELL} font-semibold`}>Chapter</th>
                <th scope="col" className="py-2 text-right font-semibold">Game clock</th>
              </tr>
            </thead>
            {players.map((player, index) => (
              <PlayerRows key={player.userId} player={player} detailsId={`humdingers-player-${index}`}
                open={open === player.userId} onToggle={() => setOpen(open === player.userId ? null : player.userId)} />
            ))}
          </table>
        </div>
      )}
    </Card>
  );
}

function PlayerRows({ player, detailsId, open, onToggle }: { player: HumdingersPlayer; detailsId: string; open: boolean; onToggle: () => void }) {
  const name = player.displayName || player.battleTag || player.email || player.userId;
  const aliases = [player.battleTag, player.email].filter((value): value is string => Boolean(value) && value !== name);
  const chapter = Math.max(player.maxChapter, player.save?.chapter ?? 0);
  const lastPlayed = latest(player.lastAt, player.save?.savedAt ?? null);
  return (
    <tbody className="border-t border-line">
      <tr>
        <th scope="row" className={`${CELL} align-top font-medium`}>
          <Link href={`/admin/users/${encodeURIComponent(player.userId)}`} className="break-all text-accent underline">{name}</Link>
          {aliases.length ? <span className="block break-all text-micro font-normal text-text-dim">{aliases.join(" · ")}</span> : null}
        </th>
        <td className={`${NUMBER_CELL} align-top`}>
          {player.sessions ? (
            <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={detailsId}
              aria-label={`${open ? "Hide" : "Show"} ${formatNumber(player.sessions)} sessions for ${name}`}
              className="-my-2 inline-flex min-h-11 items-center gap-1 font-semibold text-accent underline">
              {formatNumber(player.sessions)}
              <ChevronDown className={`h-3.5 w-3.5 motion-safe:transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
            </button>
          ) : "–"}
        </td>
        <td className={`${NUMBER_CELL} align-top`}>{player.sessions ? duration(player.activeSeconds) : "–"}</td>
        <td className={`${CELL} align-top`}>{lastPlayed ? <AdminDate value={lastPlayed} /> : "–"}</td>
        <td className={`${NUMBER_CELL} align-top`}>{chapter ? formatNumber(chapter) : "–"}</td>
        <td className="py-2 text-right align-top tabular-nums">{player.save ? duration(player.save.playtime) : "No save"}</td>
      </tr>
      {open ? (
        <tr id={detailsId}>
          <td colSpan={6} className="pb-3">
            <SessionsTable name={name} sessions={player.recent} total={player.sessions} />
          </td>
        </tr>
      ) : null}
    </tbody>
  );
}

function SessionsTable({ name, sessions, total }: { name: string; sessions: SessionRow[]; total: number }) {
  return (
    <div className="rounded-lg border border-line bg-bg-elevated/40 px-3 py-2">
      <table className="w-full text-left text-caption">
        <caption className="sr-only">Sessions for {name}, newest first</caption>
        <thead className="text-text-dim">
          <tr>
            <th scope="col" className={`${CELL} font-semibold`}>Started</th>
            <th scope="col" className={`${NUMBER_CELL} font-semibold`}>Play time</th>
            <th scope="col" className={`${NUMBER_CELL} font-semibold`}>Chapter</th>
            <th scope="col" className="py-2 text-right font-semibold">Saved</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session, index) => (
            <tr key={`${session.startedAt}-${index}`} className="border-t border-line">
              <td className={CELL}>{formatDateTime(session.startedAt)}</td>
              <td className={NUMBER_CELL}>{duration(session.activeSeconds)}</td>
              <td className={NUMBER_CELL}>{session.maxChapter ? formatNumber(session.maxChapter) : "–"}</td>
              <td className="py-2 text-right">{session.saved ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > sessions.length ? (
        <p className="py-2 text-micro text-text-dim">Showing the newest {formatNumber(sessions.length)} of {formatNumber(total)} sessions.</p>
      ) : null}
    </div>
  );
}

function DailyTable({ rows }: { rows: DayRow[] }) {
  return (
    <Card title="By day" headingLevel={2}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-caption">
          <caption className="sr-only">Humdingers plays by day</caption>
          <thead className="text-text-dim">
            <tr>
              <th scope="col" className={`${CELL} font-semibold`}>Day (UTC)</th>
              <th scope="col" className={`${NUMBER_CELL} font-semibold`}>Plays</th>
              <th scope="col" className={`${NUMBER_CELL} font-semibold`}>Players</th>
              <th scope="col" className={`${NUMBER_CELL} font-semibold`}>Play time</th>
              <th scope="col" className={`${NUMBER_CELL} font-semibold`}>Had a save</th>
              <th scope="col" className="py-2 text-right font-semibold">Furthest chapter</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.day} className="border-t border-line">
                <th scope="row" className={`${CELL} font-medium text-text`}>{formatDate(`${row.day}T00:00:00Z`, { timeZone: "UTC", month: "short", day: "numeric" })}</th>
                <td className={NUMBER_CELL}>{formatNumber(row.loads)}</td>
                <td className={NUMBER_CELL}>{formatNumber(row.players)}</td>
                <td className={NUMBER_CELL}>{duration(row.activeSeconds)}</td>
                <td className={NUMBER_CELL}>{formatNumber(row.savers)}</td>
                <td className="py-2 text-right tabular-nums">{row.maxChapter ? formatNumber(row.maxChapter) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** The later of two ISO times, or null when neither is set. */
function latest(a: string | null, b: string | null): string | null {
  if (!a || !b) return a || b;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** "45 min" or "3 h 5 min"; a few seconds read "under 1 min". */
function duration(seconds: number): string {
  if (seconds > 0 && seconds < 30) return "under 1 min";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${formatNumber(minutes)} min`;
  return `${formatNumber(Math.floor(minutes / 60))} h ${formatNumber(minutes % 60)} min`;
}
