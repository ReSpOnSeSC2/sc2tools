"use client";

import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  CalendarClock,
  CloudOff,
  Radio,
  RefreshCw,
} from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { fmtAgo, fmtMinutes, pct1 } from "@/lib/format";
import { useFilters } from "@/lib/filterContext";
import {
  formatOpenerLabel,
  metaHref,
  type MetaRow,
} from "@/lib/meta";
import {
  isFreshReplay,
  metaApiPath,
  metaSelectionForGame,
  personalFormForLatest,
  pickDailyReplay,
  pickMetaMover,
  pulseMatchup,
  pulseResult,
  sortPulseGames,
  verifiedMmrDelta,
  type MetaMover,
  type PersonalForm,
  type PulseGame,
  type PulseGamesPage,
  type PulseLeak,
  type PulseResult,
  type VerifiedMmrDelta,
} from "@/lib/ladderPulse";
import { gameAnalysisHref } from "@/lib/opponentNavigation";
import { useDailySeed } from "./arcade/hooks/useDailySeed";
import { MapLabel } from "@/components/maps/MapArtwork";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { LadderPulseFrame as PulseFrame } from "./LadderPulseFrame";

const RECENT_RAIL_SIZE = 6;
const META_REFRESH_MS = 60 * 60 * 1000;
const LS_COLLAPSED_KEY = "analyzer.ladderPulse.collapsed";

/**
 * Persistent replay-fed briefing for the analyzer.
 *
 * Freshness has three independent clocks:
 *   - every newly-ingested replay bumps AnalyzerProvider.dbRev through the
 *     existing games:changed socket;
 *   - the daily replay changes at the user's local midnight;
 *   - the corpus-wide opener movement revalidates hourly while its source is
 *     rebuilt server-side from real games.
 *
 * There is intentionally no sample payload and no additional socket.
 */
export function LadderPulse() {
  const { dbRev } = useFilters();
  const daily = useDailySeed();
  const now = useMinuteClock();
  const [collapsed, setCollapsed] = useState(false);
  const [preferenceHydrated, setPreferenceHydrated] = useState(false);
  useEffect(() => {
    setCollapsed(readCollapsed());
    setPreferenceHydrated(true);
  }, []);
  const toggle = () => {
    setCollapsed((current) => {
      const next = !current;
      writeCollapsed(next);
      return next;
    });
  };
  const gamesReq = useApi<PulseGamesPage>(
    `/v1/games?limit=40#${dbRev}`,
    { keepPreviousData: true },
  );
  const games = useMemo(
    () => sortPulseGames(gamesReq.data?.items),
    [gamesReq.data?.items],
  );
  const latest = games[0] ?? null;
  const dailyReplay = useMemo(
    () =>
      pickDailyReplay(
        games,
        daily.userId,
        daily.day,
        latest?.gameId ?? null,
      ),
    [daily.day, daily.userId, games, latest?.gameId],
  );
  const mmr = useMemo(() => verifiedMmrDelta(games), [games]);
  const personalForm = useMemo(
    () => personalFormForLatest(games),
    [games],
  );
  const metaSelection = useMemo(
    () => metaSelectionForGame(latest),
    [latest],
  );
  const metaPath = metaApiPath(metaSelection);
  const metaReq = useApi<{ row: MetaRow }>(metaPath, {
    refreshInterval: META_REFRESH_MS,
    shouldRetryOnError: false,
  });
  const metaMover = useMemo(
    () => pickMetaMover(metaReq.data?.row),
    [metaReq.data?.row],
  );

  if (!preferenceHydrated) {
    return <PulseFrame pending updatedAt={latest?.date} />;
  }
  if (collapsed) {
    return (
      <PulseFrame
        collapsed
        onToggle={toggle}
        updatedAt={latest?.date}
      />
    );
  }
  if (gamesReq.isLoading && !gamesReq.data) {
    return <PulseLoading onToggle={toggle} />;
  }
  if (gamesReq.error && !gamesReq.data) {
    return (
      <PulseFrame onToggle={toggle}>
        <EmptyStatePanel
          size="sm"
          icon={<CloudOff className="h-5 w-5" aria-hidden />}
          title="Ladder Pulse is temporarily quiet"
          description={gamesReq.error.message}
          action={
            <button
              type="button"
              onClick={() => void gamesReq.mutate()}
              className={secondaryActionClass()}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Try again
            </button>
          }
        />
      </PulseFrame>
    );
  }
  if (!latest) {
    return (
      <PulseFrame onToggle={toggle}>
        <EmptyStatePanel
          size="sm"
          icon={<Radio className="h-5 w-5" aria-hidden />}
          title="Your Ladder Pulse starts with a replay"
          description="Finish a game with the agent running and this briefing will update automatically."
          action={
            <Link href="/download" className={secondaryActionClass()}>
              Get the agent
              <ArrowUpRight className="h-4 w-4" aria-hidden />
            </Link>
          }
        />
      </PulseFrame>
    );
  }

  return (
    <PulseFrame updatedAt={latest.date} onToggle={toggle}>
      <div className="grid divide-y divide-border lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)] lg:divide-x lg:divide-y-0">
        <LatestDispatch
          key={latest.gameId}
          game={latest}
          games={games}
          mmr={mmr}
          fresh={isFreshReplay(latest, now)}
        />
        <DailyReplayCard game={dailyReplay} day={daily.day} />
        {metaMover && metaReq.data?.row && metaSelection ? (
          <MetaMovementCard
            row={metaReq.data.row}
            mover={metaMover}
            selection={metaSelection}
          />
        ) : metaPath && metaReq.isLoading ? (
          <MetaLoading />
        ) : (
          <PersonalFormCard form={personalForm} />
        )}
      </div>
    </PulseFrame>
  );
}

function LatestDispatch({
  game,
  games,
  mmr,
  fresh,
}: {
  game: PulseGame;
  games: PulseGame[];
  mmr: VerifiedMmrDelta | null;
  fresh: boolean;
}) {
  const result = pulseResult(game.result);
  const opponent = clean(game.opponent?.displayName) || "Unknown opponent";
  const matchup = pulseMatchup(game);
  const leak = bestNamedLeak(game);
  const leakSignal = leak ? formatLeakSignal(leak) : null;
  const recent = games
    .filter((row) => pulseResult(row.result) !== "unknown")
    .slice(0, RECENT_RAIL_SIZE);

  return (
    <article className="min-w-0 p-4 motion-safe:animate-[fadeIn_220ms_ease-out] sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={resultVariant(result)} size="sm">
          {resultLabel(result)}
        </Badge>
        {fresh ? (
          <Badge variant="signal" size="sm">
            Just in
          </Badge>
        ) : null}
        <span className="ml-auto text-micro text-text-dim">
          {fmtAgo(game.date)}
        </span>
      </div>

      <div className="mt-3 flex min-w-0 items-start gap-3">
        <MapLabel
          name={game.map}
          size="md"
          preview
          className="min-w-0 flex-1"
          textClassName="text-caption font-medium text-text-muted"
        />
      </div>

      <h3
        className="mt-3 text-h3 font-bold leading-tight text-text"
        aria-live="polite"
      >
        {resultHeadline(result)}{" "}
        <span className="text-accent-cyan">vs {opponent}</span>
      </h3>
      <p className="mt-1 text-caption text-text-muted">
        {[matchup, formatDuration(game.durationSec)]
          .filter(Boolean)
          .join(" · ")}
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Fact label="Your opener" value={clean(game.myBuild)} />
        <Fact
          label="They showed"
          value={clean(game.opponent?.strategy)}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {mmr ? (
          <SignalChip
            label={[
              `MMR ${mmr.to.toLocaleString()}`,
              `${mmr.delta >= 0 ? "+" : ""}${mmr.delta} vs prior`,
            ].join(" · ")}
            title="Recorded in this replay; movement is versus the prior replay on the same account and ladder race."
            tone={mmr.delta > 0 ? "success" : mmr.delta < 0 ? "danger" : "neutral"}
          />
        ) : null}
        {finite(game.macroScore) ? (
          <SignalChip
            label={`Macro ${Math.round(game.macroScore!)}`}
            tone="cyan"
          />
        ) : null}
        {leakSignal ? (
          <SignalChip
            label={leakSignal.label}
            title={leakSignal.title}
            tone="warning"
          />
        ) : null}
      </div>

      {recent.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-micro font-semibold uppercase tracking-wider text-text-dim">
            Recent
          </span>
          <ol
            className="flex flex-wrap gap-1.5"
            aria-label="Recent replay results, newest first"
          >
            {recent.map((row) => {
              const rowResult = pulseResult(row.result);
              const rowOpponent =
                clean(row.opponent?.displayName) || "unknown opponent";
              return (
                <li key={row.gameId}>
                  <Link
                    href={gameAnalysisHref(row.gameId)}
                    aria-label={`${resultLabel(rowResult)} against ${rowOpponent}, ${fmtAgo(row.date)}`}
                    title={`${resultLabel(rowResult)} vs ${rowOpponent}`}
                    className={[
                      "grid h-7 w-7 place-items-center rounded-full border text-micro font-bold transition-transform",
                      "motion-safe:hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      resultPipClass(rowResult),
                    ].join(" ")}
                  >
                    {resultShortLabel(rowResult)}
                  </Link>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      <Link
        href={gameAnalysisHref(game.gameId)}
        className={`${primaryActionClass()} mt-4`}
      >
        Open full analysis
        <ArrowUpRight className="h-4 w-4" aria-hidden />
      </Link>
    </article>
  );
}

function DailyReplayCard({
  game,
  day,
}: {
  game: PulseGame | null;
  day: string;
}) {
  if (!game) {
    return (
      <aside className="min-w-0 p-4 sm:p-5" aria-label="Daily replay">
        <PaneEyebrow
          icon={<CalendarClock className="h-4 w-4" />}
          label="Daily replay"
        />
        <p className="mt-3 text-caption text-text-muted">
          A replay from your history will rotate into this slot once there is
          another finished game to revisit.
        </p>
      </aside>
    );
  }

  const result = pulseResult(game.result);
  const opponent = clean(game.opponent?.displayName) || "an opponent";
  return (
    <aside className="min-w-0 p-4 sm:p-5" aria-label="Daily replay">
      <PaneEyebrow
        icon={<CalendarClock className="h-4 w-4" />}
        label="Daily replay"
        suffix={day}
      />
      <Badge variant={resultVariant(result)} size="sm" className="mt-3">
        {resultLabel(result)}
      </Badge>
      <h3 className="mt-2 text-h4 font-bold leading-snug text-text">
        Revisit your {resultLabel(result).toLowerCase()} vs {opponent}
      </h3>
      <div className="mt-3">
        <MapLabel
          name={game.map}
          size="sm"
          preview
          textClassName="text-caption text-text-muted"
        />
      </div>
      <dl className="mt-3 space-y-2">
        <CompactFact label="Your opener" value={clean(game.myBuild)} />
        <CompactFact
          label="Opponent"
          value={clean(game.opponent?.strategy)}
        />
        <CompactFact
          label="Length"
          value={formatDuration(game.durationSec)}
        />
      </dl>
      <Link
        href={gameAnalysisHref(game.gameId)}
        className={`${secondaryActionClass()} mt-4`}
      >
        Reopen replay
        <ArrowUpRight className="h-4 w-4" aria-hidden />
      </Link>
    </aside>
  );
}

function MetaMovementCard({
  row,
  mover,
  selection,
}: {
  row: MetaRow;
  mover: MetaMover;
  selection: NonNullable<ReturnType<typeof metaSelectionForGame>>;
}) {
  const opener = mover.opener;
  const movement =
    mover.kind === "new"
      ? "New in this published sample"
      : mover.kind === "rising"
        ? `Usage ${formatSignedPoints(opener.freqDelta)}`
        : "Most played in this sample";
  return (
    <aside className="min-w-0 p-4 sm:p-5" aria-label="Ladder meta movement">
      <PaneEyebrow
        icon={<BarChart3 className="h-4 w-4" />}
        label="Across SC2 Tools"
        suffix={row.bandLabel}
      />
      <Badge
        variant={mover.kind === "new" ? "signal" : "cyan"}
        size="sm"
        className="mt-3"
      >
        {mover.kind === "new" ? "New" : mover.kind === "rising" ? "Rising" : "Meta"}
      </Badge>
      <h3 className="mt-2 text-h4 font-bold leading-snug text-text">
        {formatOpenerLabel(opener.build)}
      </h3>
      <p className="mt-1 text-caption font-medium text-accent-cyan">
        {movement}
      </p>
      <p className="mt-3 text-caption text-text-muted">
        {opener.games.toLocaleString()} games · {pct1(opener.winRate)} win rate
        {" · "}
        {pct1(opener.frequency)} of published {row.matchup} openers
      </p>
      <p className="mt-2 text-micro text-text-dim">
        Nightly aggregate · updated {fmtAgo(row.updatedAt)}
      </p>
      <Link
        href={metaHref(
          selection.axis,
          selection.band,
          selection.matchup,
          selection.era,
        )}
        className={`${secondaryActionClass()} mt-4`}
      >
        Open meta radar
        <ArrowUpRight className="h-4 w-4" aria-hidden />
      </Link>
    </aside>
  );
}

function PersonalFormCard({ form }: { form: PersonalForm | null }) {
  if (!form) {
    return (
      <aside className="min-w-0 p-4 sm:p-5" aria-label="Recent form">
        <PaneEyebrow
          icon={<Activity className="h-4 w-4" />}
          label="Recent form"
        />
        <p className="mt-3 text-caption text-text-muted">
          This signal fills in as more decided games arrive in your recent
          replay window.
        </p>
      </aside>
    );
  }

  const heading =
    form.kind === "build"
      ? formatOpenerLabel(form.label)
      : form.kind === "matchup"
        ? `${form.label} form`
        : form.label;
  const scope =
    form.kind === "build"
      ? `${form.total} appearances in your latest ${form.windowGames} synced games`
      : form.kind === "matchup"
        ? `${form.total} ${form.label} games in your latest ${form.windowGames} synced games`
        : `${form.total} most recent decided games`;

  return (
    <aside className="min-w-0 p-4 sm:p-5" aria-label="Recent form">
      <PaneEyebrow
        icon={<Activity className="h-4 w-4" />}
        label="Your recent form"
      />
      <h3 className="mt-3 text-h4 font-bold leading-snug text-text">
        {heading}
      </h3>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="font-display text-h2 font-bold tabular-nums text-text">
          {form.wins}-{form.losses}
        </span>
        {form.ties > 0 ? (
          <span className="text-caption text-text-muted">
            · {form.ties} {form.ties === 1 ? "tie" : "ties"}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-caption text-text-muted">{scope}</p>
      <p className="mt-2 text-micro text-text-dim">
        Shown when a matching published k-anonymous meta row is unavailable.
      </p>
    </aside>
  );
}

function MetaLoading() {
  return (
    <aside
      className="min-w-0 p-4 sm:p-5"
      aria-busy="true"
      aria-label="Loading ladder meta movement"
    >
      <PaneEyebrow
        icon={<BarChart3 className="h-4 w-4" />}
        label="Across SC2 Tools"
      />
      <div className="mt-4 space-y-3">
        <div className="h-5 w-20 rounded bg-bg-subtle motion-safe:animate-pulse" />
        <div className="h-6 w-4/5 rounded bg-bg-subtle motion-safe:animate-pulse" />
        <div className="h-4 w-full rounded bg-bg-subtle motion-safe:animate-pulse" />
      </div>
    </aside>
  );
}

function PulseLoading({ onToggle }: { onToggle: () => void }) {
  return (
    <PulseFrame onToggle={onToggle}>
      <div
        className="grid divide-y divide-border lg:grid-cols-3 lg:divide-x lg:divide-y-0"
        aria-busy="true"
        aria-label="Loading Ladder Pulse"
      >
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="space-y-3 p-5">
            <div className="h-5 w-24 rounded bg-bg-subtle motion-safe:animate-pulse" />
            <div className="h-7 w-4/5 rounded bg-bg-subtle motion-safe:animate-pulse" />
            <div className="h-4 w-full rounded bg-bg-subtle motion-safe:animate-pulse" />
            <div className="h-4 w-2/3 rounded bg-bg-subtle motion-safe:animate-pulse" />
          </div>
        ))}
      </div>
    </PulseFrame>
  );
}

function PaneEyebrow({
  icon,
  label,
  suffix,
}: {
  icon: ReactNode;
  label: string;
  suffix?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-micro font-semibold uppercase tracking-wider text-text-dim">
      <span className="text-accent-cyan" aria-hidden>
        {icon}
      </span>
      <span className="truncate">{label}</span>
      {suffix ? (
        <span className="ml-auto truncate font-mono font-normal normal-case tracking-normal text-text-dim">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="rounded-lg border border-border bg-bg-elevated px-3 py-2">
      <div className="text-micro uppercase tracking-wider text-text-dim">
        {label}
      </div>
      <div className="mt-0.5 truncate text-caption font-medium text-text" title={value}>
        {value}
      </div>
    </div>
  );
}

function CompactFact({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-caption">
      <dt className="text-text-dim">{label}</dt>
      <dd className="truncate text-text" title={value}>
        {value}
      </dd>
    </div>
  );
}

function SignalChip({
  label,
  tone,
  title,
}: {
  label: string;
  tone: BadgeVariant;
  title?: string;
}) {
  return (
    <Badge
      variant={tone}
      size="sm"
      className="max-w-full"
      title={title}
    >
      <span className="truncate">{label}</span>
    </Badge>
  );
}

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function readCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LS_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    /* A blocked preference store should never break the live pulse. */
  }
}

function bestNamedLeak(game: PulseGame) {
  const leaks = Array.isArray(game.top3Leaks)
    ? game.top3Leaks.filter((leak) => clean(leak?.name))
    : [];
  return leaks
    .slice()
    .sort(
      (a, b) =>
        (finite(b.mineral_cost) ? b.mineral_cost! : -1) -
        (finite(a.mineral_cost) ? a.mineral_cost! : -1),
    )[0] ?? null;
}

/**
 * `mineral_cost` is normally an estimated opportunity cost. For Mineral
 * Float, however, the scorer uses it only as a ranking weight (high-bank
 * sample count × 100). Presenting that weight as a literal mineral balance
 * makes a 20-sample float look like a 2,000-mineral bank, so this signal uses
 * the observed sample count instead.
 */
function formatLeakSignal(leak: PulseLeak): {
  label: string;
  title?: string;
} {
  const name = clean(leak.name) || "Macro leak";
  const detail = clean(leak.detail) || undefined;

  if (name.toLowerCase() === "mineral float") {
    const samples =
      finite(leak.quantity) && leak.quantity! >= 0
        ? Math.round(leak.quantity!)
        : null;
    return {
      label:
        samples == null
          ? name
          : `${name} · ${samples.toLocaleString()} ${
              samples === 1 ? "reading" : "readings"
            } over 800 minerals`,
      title: detail,
    };
  }

  return {
    label: [
      name,
      finite(leak.mineral_cost)
        ? `${Math.round(leak.mineral_cost!)} minerals`
        : "",
    ]
      .filter(Boolean)
      .join(" · "),
    title: detail,
  };
}

function resultVariant(result: PulseResult): BadgeVariant {
  if (result === "win") return "success";
  if (result === "loss") return "danger";
  if (result === "tie") return "warning";
  return "neutral";
}

function resultLabel(result: PulseResult): string {
  if (result === "win") return "Victory";
  if (result === "loss") return "Defeat";
  if (result === "tie") return "Tie";
  return "Result pending";
}

function resultHeadline(result: PulseResult): string {
  if (result === "win") return "Victory secured";
  if (result === "loss") return "Replay ready";
  if (result === "tie") return "Draw recorded";
  return "New replay";
}

function resultShortLabel(result: PulseResult): string {
  if (result === "win") return "W";
  if (result === "loss") return "L";
  if (result === "tie") return "T";
  return "–";
}

function resultPipClass(result: PulseResult): string {
  if (result === "win") {
    return "border-success/40 bg-success/15 text-success";
  }
  if (result === "loss") {
    return "border-danger/40 bg-danger/15 text-danger";
  }
  if (result === "tie") {
    return "border-warning/40 bg-warning/15 text-warning";
  }
  return "border-border bg-bg-elevated text-text-dim";
}

function formatDuration(value: number | null | undefined): string {
  return finite(value) && value! >= 0 ? fmtMinutes(value) : "";
}

function formatSignedPoints(value: number | null | undefined): string {
  if (!finite(value)) return "changed";
  const points = value! * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pts week over week`;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function primaryActionClass(): string {
  return [
    "hard-press inline-flex min-h-[40px] items-center justify-center gap-2 rounded-full",
    "border-2 border-line bg-accent px-4 py-2 font-display text-caption font-bold text-white",
    "hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
  ].join(" ");
}

function secondaryActionClass(): string {
  return [
    "hard-press inline-flex min-h-[40px] items-center justify-center gap-2 rounded-full",
    "border-2 border-line bg-bg-surface px-4 py-2 font-display text-caption font-bold text-text",
    "hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
  ].join(" ");
}
