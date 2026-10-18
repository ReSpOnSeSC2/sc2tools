"use client";

import { useId, useMemo, useState } from "react";
import { Building2, Check, Coins, Flame, Gem, Pickaxe, RefreshCcw, Swords } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatGameClock } from "@/lib/macro";
import type { PatchEra } from "@/lib/meta";
import type { CasualtyCategory, CasualtyEvent } from "./MacroBreakdownPanel.types";
import { buildCasualtyTimeline, CASUALTY_CATEGORIES, casualtiesAt } from "./casualtiesAt";

const CATEGORY = {
  units: { label: "Units", icon: Swords },
  buildings: { label: "Buildings", icon: Building2 },
  workers: { label: "Workers", icon: Pickaxe },
} as const;

/** Cumulative deaths through the inspected moment, with independent filters.
 * Keep the army selection while the worker metric temporarily narrows it. */
export function CasualtySnapshot({
  events,
  time,
  workersOnly,
  myName,
  oppName,
  onRecompute,
  recomputing = false,
  patchEra,
}: {
  events?: CasualtyEvent[];
  time: number;
  workersOnly: boolean;
  myName?: string | null;
  oppName?: string | null;
  onRecompute?: () => void;
  recomputing?: boolean;
  patchEra?: PatchEra | null;
}) {
  const headingId = useId();
  const [selected, setSelected] = useState<readonly CasualtyCategory[]>(CASUALTY_CATEGORIES);
  const timeline = useMemo(() => buildCasualtyTimeline(events ?? [], patchEra), [events, patchEra]);
  const counts = casualtiesAt(timeline, time);
  const visible = workersOnly ? ["workers" as const] : selected;
  const clock = formatGameClock(time);
  const players = [
    { key: "me", name: myName?.trim() || "You", dot: "bg-player-you" },
    { key: "opp", name: oppName?.trim() || "Opponent", dot: "bg-player-opp" },
  ] as const;
  const totals = players.flatMap((player) =>
    (["killed", "lost"] as const).map((kind) => ({
      player: player.name,
      kind,
      ...visible.reduce((sum, category) => {
        const cost = counts[player.key][category][kind === "killed" ? "killedCost" : "lostCost"];
        return {
          minerals: sum.minerals + cost.minerals,
          gas: sum.gas + cost.gas,
          unpriced: sum.unpriced + cost.unpriced,
        };
      }, { minerals: 0, gas: 0, unpriced: 0 }),
    })),
  );
  const hasUnpriced = totals.some((cost) => cost.unpriced > 0);
  const hasArchons = visible.includes("units") && events?.some((event) =>
    event.time <= time && event.name === "Archon",
  );

  return (
    <section
      aria-labelledby={headingId}
      data-timeline-control=""
      className="overflow-hidden rounded-lg border border-border bg-bg-surface"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-3 py-2.5 sm:px-4">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 id={headingId} className="text-caption font-semibold uppercase tracking-wider text-text">
              Killed &amp; lost
            </h3>
            <span className="text-micro tabular-nums text-text-muted">Through {clock}</span>
          </div>
          <p className="mt-0.5 text-micro text-text-muted">
            {workersOnly ? "Worker kills, losses and resource costs" : "Cumulative counts and costs · Units exclude workers"}
          </p>
        </div>
        {!workersOnly ? (
          <div role="group" aria-label="Casualty categories" className="grid w-full grid-cols-3 gap-1.5 sm:flex sm:w-auto sm:flex-wrap">
            {CASUALTY_CATEGORIES.map((category) => {
              const { label, icon: Glyph } = CATEGORY[category];
              const pressed = selected.includes(category);
              return (
                <button
                  key={category}
                  type="button"
                  aria-label={`Show ${label}`}
                  aria-pressed={pressed}
                  onClick={() => setSelected((previous) => CASUALTY_CATEGORIES.filter((key) =>
                    key === category ? !previous.includes(key) : previous.includes(key),
                  ))}
                  className={`inline-flex min-h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-micro font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface sm:px-2.5 ${
                    pressed
                      ? "border-accent/40 bg-accent/10 text-text"
                      : "border-border bg-bg-surface text-text-muted hover:border-border-strong hover:bg-bg-subtle hover:text-text"
                  }`}
                >
                  <Glyph aria-hidden className="hidden h-3.5 w-3.5 sm:block" />
                  {label}
                  <Check aria-hidden className={`h-3 w-3 text-accent-cyan ${pressed ? "" : "invisible"}`} />
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      {!Array.isArray(events) ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-4 sm:px-4">
          <p className="text-caption text-text-muted">
            Kill and loss details are unavailable for this replay. Re-analyze it to add them.
          </p>
          {onRecompute ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRecompute}
              loading={recomputing}
              iconLeft={<RefreshCcw aria-hidden className="h-3.5 w-3.5" />}
            >
              {recomputing ? "Requesting…" : "Re-analyze replay"}
            </Button>
          ) : null}
        </div>
      ) : visible.length === 0 ? (
        <p className="px-3 py-4 text-caption text-text-muted sm:px-4">
          Select a category to see kills and losses.
        </p>
      ) : (
        <>
        <table className="w-full table-fixed text-left text-caption">
          <caption className="sr-only">Kills and losses at {clock}</caption>
          <colgroup>
            <col className="w-[24%] sm:w-[32%]" />
            <col /><col /><col /><col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" rowSpan={2} className="px-3 py-2 align-bottom text-micro font-medium text-text-muted sm:px-4">
                Category
              </th>
              {players.map((player) => (
                <th key={player.key} scope="colgroup" colSpan={2} className="border-l border-border px-2 pb-0.5 pt-2 text-micro font-semibold text-text sm:px-3">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${player.dot}`} />
                    <span className="truncate" title={player.name}>{player.name}</span>
                  </span>
                </th>
              ))}
            </tr>
            <tr>
              {players.map((player) => (
                (["Killed", "Lost"] as const).map((label, index) => (
                  <th key={`${player.key}-${label}`} scope="col" className={`px-2 pb-2 text-right text-micro font-normal text-text-muted sm:px-3 ${index === 0 ? "border-l border-border" : ""}`}>
                    {label}
                  </th>
                ))
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((category) => {
              const { label, icon: Glyph } = CATEGORY[category];
              return (
                <tr key={category} className="border-t border-border">
                  <th scope="row" className="px-3 py-2.5 font-medium text-text sm:px-4">
                    <span className="flex items-center gap-2">
                      <Glyph aria-hidden className="hidden h-3.5 w-3.5 shrink-0 text-text-muted min-[400px]:block" />
                      {label}
                    </span>
                  </th>
                  {players.map((player) => (
                    (["killed", "lost"] as const).map((kind, index) => (
                      <td key={`${player.key}-${kind}`} className={`px-2 py-2.5 text-right font-semibold tabular-nums text-text sm:px-3 ${index === 0 ? "border-l border-border" : ""}`}>
                        {counts[player.key][category][kind].toLocaleString()}
                      </td>
                    ))
                  ))}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            {([
              { key: "minerals", label: "Minerals", icon: Gem },
              { key: "gas", label: "Gas", icon: Flame },
              { key: "total", label: "Total", icon: Coins },
            ] as const).map((resource, rowIndex) => {
              const Glyph = resource.icon;
              return (
                <tr
                  key={resource.key}
                  className={`bg-bg-subtle/40 ${rowIndex === 0 ? "border-t-2 border-border-strong" : "border-t border-border"}`}
                >
                  <th scope="row" className={`px-3 py-2 text-micro sm:px-4 ${resource.key === "total" ? "font-semibold text-text" : "font-medium text-text-muted"}`}>
                    <span className="flex items-center gap-2">
                      <Glyph aria-hidden className="hidden h-3.5 w-3.5 shrink-0 min-[400px]:block" />
                      {resource.label}
                    </span>
                  </th>
                  {totals.map((cost, columnIndex) => {
                    const value = resource.key === "total" ? cost.minerals + cost.gas : cost[resource.key];
                    const formatted = value.toLocaleString();
                    return (
                      <td
                        key={`${cost.player}-${cost.kind}-${columnIndex}`}
                        title={`${cost.player} ${cost.kind}: ${cost.unpriced > 0 ? "at least " : ""}${formatted} ${resource.key === "total" ? "resources (minerals + gas)" : resource.label.toLowerCase()}`}
                        className={`px-1.5 py-2 text-right tabular-nums sm:px-3 ${columnIndex % 2 === 0 ? "border-l border-border" : ""} ${resource.key === "total" ? "font-bold text-text" : "text-text-muted"}`}
                      >
                        {cost.unpriced > 0 ? "≥" : ""}{formatted}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tfoot>
        </table>
        <div className="space-y-1 border-t border-border px-3 py-2 text-micro text-text-muted sm:px-4">
          <p>
            {workersOnly
              ? "Worker resource costs at the selected time."
              : "Full investment for selected categories, including morphs and consumed workers."}
            {hasArchons ? " Archons assume two High Templar." : ""}
          </p>
          {hasUnpriced ? (
            <p>Some casualties have no recorded price; resource totals are a lower bound.</p>
          ) : null}
        </div>
        </>
      )}
    </section>
  );
}
