"use client";

import { Icon } from "@/components/ui/Icon";
import { formatGameClock } from "@/lib/macro";
import type {
  PlayerStats,
  PlayerStatsRecord,
} from "./MacroBreakdownPanel.types";

export interface PlayerStatsTableProps {
  stats?: PlayerStats | null;
  /**
   * Caller-supplied fallback names — preferred when the agent
   * payload omits them or includes a Battle.net tag the user has
   * already seen elsewhere on the page.
   */
  myName?: string | null;
  oppName?: string | null;
  myRace?: string | null;
  oppRace?: string | null;
}

interface Column {
  key: string;
  label: string;
  /** Right-align numeric columns; left-align text. */
  align: "left" | "right";
  /** Pull a value from the per-row record. */
  get: (row: ResolvedRow) => string;
}

interface ResolvedRow {
  team: number;
  player: PlayerStatsRecord;
  fallbackName: string;
  fallbackRace: string;
}

/**
 * Replay Player Unit Statistics — production-grade port of the table
 * sc2replaystats shows in its overview. Surfaces MMR, race, APM/SPM
 * and the cumulative born/died counters the agent computes during
 * its tracker walk. Renders nothing when player_stats is missing
 * (older payloads); the parent decides whether to gate the section.
 *
 * Mobile UX: on narrow viewports the table switches to a stacked
 * card layout per player so the long column list stays legible
 * without horizontal scroll. Desktop keeps the dense classic table.
 */
export function PlayerStatsTable({
  stats,
  myName,
  oppName,
  myRace,
  oppRace,
}: PlayerStatsTableProps) {
  const rows = useResolvedRows(stats, {
    myName: myName ?? null,
    oppName: oppName ?? null,
    myRace: myRace ?? null,
    oppRace: oppRace ?? null,
  });
  if (rows.length === 0) {
    return (
      <p className="text-caption text-text-muted">
        Per-player unit statistics become available once your agent uploads a
        replay with the v0.5+ pipeline. Click Recompute to ask the agent to
        re-parse this game.
      </p>
    );
  }
  const columns = COLUMNS;

  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-border bg-bg-elevated md:block">
        <table className="w-full text-caption tabular-nums">
          <thead className="bg-bg-subtle text-[11px] uppercase tracking-wider text-text-muted">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={`px-3 py-2 font-semibold ${
                    col.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.team}
                className="border-t border-border last:border-b-0 hover:bg-bg-subtle/40"
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-3 py-2 ${
                      col.align === "right"
                        ? "text-right text-text"
                        : "text-left text-text"
                    }`}
                  >
                    {col.key === "player" ? (
                      <PlayerCell row={row} />
                    ) : (
                      col.get(row)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="grid grid-cols-1 gap-3 md:hidden">
        {rows.map((row) => (
          <li
            key={row.team}
            className="rounded-md border border-border bg-bg-elevated p-3 text-caption"
          >
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <PlayerCell row={row} />
              <span className="text-[11px] uppercase tracking-wider text-text-muted">
                Team {row.team}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] tabular-nums">
              {columns
                .filter((c) => c.key !== "player" && c.key !== "team")
                .map((col) => (
                  <div
                    key={col.key}
                    className="flex items-baseline justify-between gap-2"
                  >
                    <dt className="text-text-muted">{col.label}</dt>
                    <dd className="text-text">{col.get(row)}</dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function PlayerCell({ row }: { row: ResolvedRow }) {
  const race = row.player.race?.trim() || row.fallbackRace;
  const raceLetter = race ? race.charAt(0).toUpperCase() : "";
  const name =
    (row.player.name && row.player.name.trim()) ||
    row.fallbackName ||
    `Player ${row.team}`;
  const mmrLabel = formatMmr(row.player.mmr);
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {raceLetter ? (
        <Icon
          name={raceLetter}
          kind="race"
          size="sm"
          fallback={raceLetter}
          decorative
        />
      ) : null}
      <span className="min-w-0">
        <span className="block truncate font-semibold text-text">{name}</span>
        {mmrLabel ? (
          <span className="block text-[11px] text-text-muted">{mmrLabel}</span>
        ) : null}
      </span>
    </span>
  );
}

function formatMmr(mmr?: number | null): string {
  if (typeof mmr !== "number" || !Number.isFinite(mmr) || mmr <= 0) return "";
  return `MMR ${mmr.toLocaleString()}`;
}

function fmtNum(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString();
}

function fmtFloat(n: number | null | undefined, decimals = 1): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toFixed(decimals);
}

function fmtSeconds(s: number | null | undefined): string {
  if (typeof s !== "number" || !Number.isFinite(s)) return "—";
  return formatGameClock(Math.max(0, Math.round(s)));
}

const COLUMNS: Column[] = [
  {
    key: "player",
    label: "Player",
    align: "left",
    get: (row) => row.player.name || `Player ${row.team}`,
  },
  {
    key: "team",
    label: "Team",
    align: "left",
    get: (row) => String(row.team),
  },
  {
    key: "mmr",
    label: "MMR",
    align: "right",
    get: (row) => fmtNum(row.player.mmr),
  },
  {
    key: "units_produced",
    label: "Units Produced",
    align: "right",
    get: (row) => fmtNum(row.player.units_produced),
  },
  {
    key: "units_killed",
    label: "Units Killed",
    align: "right",
    get: (row) => fmtNum(row.player.units_killed),
  },
  {
    key: "structures_killed",
    label: "Structures Killed",
    align: "right",
    get: (row) => fmtNum(row.player.structures_killed),
  },
  {
    key: "workers_built",
    label: "Workers Built",
    align: "right",
    get: (row) => fmtNum(row.player.workers_built),
  },
  {
    key: "supply_blocked",
    label: "Supply Blocked",
    align: "right",
    get: (row) => fmtSeconds(row.player.supply_blocked_seconds),
  },
  {
    key: "apm",
    label: "APM",
    align: "right",
    get: (row) => fmtFloat(row.player.apm, 0),
  },
  {
    key: "spm",
    label: "SPM",
    align: "right",
    get: (row) => fmtFloat(row.player.spm, 2),
  },
];

function useResolvedRows(
  stats: PlayerStats | null | undefined,
  fallback: {
    myName: string | null;
    oppName: string | null;
    myRace: string | null;
    oppRace: string | null;
  },
): ResolvedRow[] {
  const me = stats?.me ?? null;
  const opp = stats?.opponent ?? null;
  const rows: ResolvedRow[] = [];
  if (me) {
    rows.push({
      team: 1,
      player: me,
      fallbackName: fallback.myName?.trim() || "You",
      fallbackRace: fallback.myRace?.trim() || "",
    });
  }
  if (opp) {
    rows.push({
      team: 2,
      player: opp,
      fallbackName: fallback.oppName?.trim() || "Opponent",
      fallbackRace: fallback.oppRace?.trim() || "",
    });
  }
  return rows;
}
