"use client";

import { useId } from "react";
import { BookOpenCheck, Info, TimerReset, Trash2 } from "lucide-react";
import { RaceIcon } from "@/components/overlay/WidgetShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Select } from "@/components/ui/Select";
import type {
  GhostBuildConfig,
  GhostMatchupKey,
  GhostTarget,
  SavedGhostBuild,
} from "@/lib/ghostBuild";

type ConcreteRace = "Terran" | "Protoss" | "Zerg";

interface RaceGroup {
  race: ConcreteRace;
  matchups: ReadonlyArray<{
    key: GhostMatchupKey;
    opponent: ConcreteRace;
  }>;
}

/**
 * Deliberately grouped by the streamer's race instead of presenting a
 * flat nine-item matrix. A user can scan "When I play Terran" and fill
 * the three decisions they actually make at the loading screen.
 */
const RACE_GROUPS: ReadonlyArray<RaceGroup> = [
  {
    race: "Terran",
    matchups: [
      { key: "TvT", opponent: "Terran" },
      { key: "TvP", opponent: "Protoss" },
      { key: "TvZ", opponent: "Zerg" },
    ],
  },
  {
    race: "Protoss",
    matchups: [
      { key: "PvT", opponent: "Terran" },
      { key: "PvP", opponent: "Protoss" },
      { key: "PvZ", opponent: "Zerg" },
    ],
  },
  {
    race: "Zerg",
    matchups: [
      { key: "ZvT", opponent: "Terran" },
      { key: "ZvP", opponent: "Protoss" },
      { key: "ZvZ", opponent: "Zerg" },
    ],
  },
];

export interface GhostMatchupManagerProps {
  /** Validated v2 Ghost configuration. Persistence remains the parent's job. */
  loadout: GhostBuildConfig;
  /** Builds saved from completed games, each pinned to one exact matchup. */
  library: ReadonlyArray<SavedGhostBuild>;
  /** Assign or replace one matchup slot with a saved library entry. */
  onAssign: (matchup: GhostMatchupKey, build: SavedGhostBuild) => void;
  /** Clear one slot without removing the saved build from the library. */
  onClear: (matchup: GhostMatchupKey) => void;
  /** Locks controls while the parent is saving or when settings are read-only. */
  disabled?: boolean;
}

/**
 * Nine-matchup Ghost Build control.
 *
 * The component is intentionally storage-agnostic: it renders a validated
 * loadout and emits explicit assignment/clear intents. This keeps localStorage,
 * cloud preferences, optimistic saves, and error handling outside the visual
 * layer while making the control reusable in Settings or onboarding.
 */
export function GhostMatchupManager({
  loadout,
  library,
  onAssign,
  onClear,
  disabled = false,
}: GhostMatchupManagerProps) {
  const controlId = useId();

  return (
    <section
      aria-labelledby={`${controlId}-title`}
      className="min-w-0 max-w-full space-y-5"
      data-testid="ghost-matchup-manager"
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3
            id={`${controlId}-title`}
            className="font-display text-display-sm font-bold text-text"
          >
            Matchup build coach
          </h3>
          <p className="mt-1 max-w-3xl text-caption text-text-muted">
            Choose one saved, timed build for each matchup. Ghost waits for the
            loading-screen races, then coaches only the matching slot.
          </p>
        </div>
        <Badge variant="cyan" size="md" className="w-fit flex-shrink-0">
          {assignedCount(loadout)} / 9 ready
        </Badge>
      </div>

      <div
        role="note"
        className="flex min-w-0 items-start gap-2.5 rounded-lg border border-accent-cyan/30 bg-accent-cyan/10 px-3 py-2.5 text-caption text-text-muted"
      >
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent-cyan" aria-hidden />
        <p className="min-w-0 break-words">
          <strong className="font-semibold text-text">Random opponents are disabled.</strong>{" "}
          Ghost pauses for the entire game and shows “No build order vs Random
          players,” so it never gives you the wrong build after their race is revealed.
        </p>
      </div>

      {library.length === 0 ? (
        <div
          className="min-w-0 rounded-xl border border-dashed border-border bg-bg-elevated/40 px-4"
          data-testid="ghost-library-empty"
        >
          <EmptyStatePanel
            size="sm"
            icon={<BookOpenCheck className="h-6 w-6" aria-hidden />}
            title="No timed builds saved yet"
            description="Open a completed game, review your build order, and save it for that matchup. It will appear here without replacing builds saved for the other eight matchups."
          />
        </div>
      ) : null}

      <div className="min-w-0 space-y-6">
        {RACE_GROUPS.map((group) => (
          <RaceMatchupGroup
            key={group.race}
            idBase={controlId}
            group={group}
            loadout={loadout}
            library={library}
            disabled={disabled}
            onAssign={onAssign}
            onClear={onClear}
          />
        ))}
      </div>
    </section>
  );
}

function RaceMatchupGroup({
  idBase,
  group,
  loadout,
  library,
  disabled,
  onAssign,
  onClear,
}: {
  idBase: string;
  group: RaceGroup;
  loadout: GhostBuildConfig;
  library: ReadonlyArray<SavedGhostBuild>;
  disabled: boolean;
  onAssign: GhostMatchupManagerProps["onAssign"];
  onClear: GhostMatchupManagerProps["onClear"];
}) {
  const groupId = `${idBase}-${group.race.toLowerCase()}`;
  const configured = group.matchups.filter((m) => loadout.slots[m.key]).length;

  return (
    <fieldset
      className="min-w-0 rounded-xl border border-border bg-bg-surface/60 p-3 sm:p-4"
      data-testid={`ghost-race-group-${group.race.toLowerCase()}`}
    >
      <legend className="max-w-full px-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <RaceIcon race={group.race} size={24} />
          <span id={`${groupId}-legend`} className="font-display text-body-lg font-bold text-text">
            When you play {group.race}
          </span>
          <span className="text-micro tabular-nums text-text-dim">
            {configured}/3
          </span>
        </span>
      </legend>

      <div className="mt-2 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {group.matchups.map(({ key, opponent }) => (
          <MatchupSlot
            key={key}
            idBase={idBase}
            matchup={key}
            myRace={group.race}
            opponentRace={opponent}
            target={loadout.slots[key] ?? null}
            library={library.filter((build) => build.matchup === key)}
            disabled={disabled}
            onAssign={onAssign}
            onClear={onClear}
          />
        ))}
      </div>
    </fieldset>
  );
}

function MatchupSlot({
  idBase,
  matchup,
  myRace,
  opponentRace,
  target,
  library,
  disabled,
  onAssign,
  onClear,
}: {
  idBase: string;
  matchup: GhostMatchupKey;
  myRace: ConcreteRace;
  opponentRace: ConcreteRace;
  target: GhostTarget | null;
  library: ReadonlyArray<SavedGhostBuild>;
  disabled: boolean;
  onAssign: GhostMatchupManagerProps["onAssign"];
  onClear: GhostMatchupManagerProps["onClear"];
}) {
  const selectId = `${idBase}-${matchup}-build`;
  const helpId = `${idBase}-${matchup}-help`;
  const selectedEntry = target
    ? library.find((build) => sameTarget(build.target, target)) ?? null
    : null;
  const value = selectedEntry ? `saved:${selectedEntry.id}` : target ? "current" : "";
  const hasChoices = library.length > 0;

  function assign(valueToAssign: string) {
    if (!valueToAssign.startsWith("saved:")) return;
    const id = valueToAssign.slice("saved:".length);
    const build = library.find((entry) => entry.id === id);
    if (build) onAssign(matchup, build);
  }

  return (
    <article
      aria-labelledby={`${selectId}-title`}
      className="flex min-w-0 max-w-full flex-col rounded-lg border border-border bg-bg-elevated/50 p-3"
      data-matchup={matchup}
      data-testid={`ghost-matchup-slot-${matchup}`}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <RaceIcon race={myRace} size={20} />
          <span className="text-micro font-bold uppercase tracking-wider text-text-dim">
            vs
          </span>
          <RaceIcon race={opponentRace} size={20} />
          <h4 id={`${selectId}-title`} className="ml-1 font-display text-body font-bold text-text">
            {matchup}
          </h4>
        </div>
        <Badge variant={target ? "success" : "neutral"} size="sm" className="flex-shrink-0">
          {target ? "Ready" : "Empty"}
        </Badge>
      </div>

      <div className="mt-3 min-w-0 flex-1">
        {target ? (
          <SelectedTargetSummary target={target} />
        ) : (
          <div className="rounded-md border border-dashed border-border px-2.5 py-2">
            <p className="text-caption font-medium text-text">No coach assigned</p>
            <p className="mt-0.5 break-words text-micro text-text-dim">
              {hasChoices
                ? `Choose one of your saved ${matchup} builds below.`
                : `Save a build from a completed ${matchup} game to fill this slot.`}
            </p>
          </div>
        )}
      </div>

      <div className="mt-3 min-w-0 space-y-1.5">
        <label htmlFor={selectId} className="block text-micro font-semibold uppercase tracking-wider text-text-dim">
          {target ? "Replace saved build" : "Saved build"}
        </label>
        <Select
          id={selectId}
          value={value}
          selectSize="sm"
          disabled={disabled || !hasChoices}
          aria-describedby={helpId}
          aria-label={`${target ? "Replace" : "Select"} build for ${matchup}`}
          onChange={(event) => assign(event.target.value)}
          className="min-w-0 max-w-full"
        >
          {!target ? <option value="">Choose a saved {matchup} build</option> : null}
          {target && !selectedEntry ? (
            <option value="current">Current: {target.name}</option>
          ) : null}
          {library.map((build) => (
            <option key={build.id} value={`saved:${build.id}`}>
              {build.target.name}
            </option>
          ))}
        </Select>
        <p id={helpId} className="break-words text-micro text-text-dim">
          {hasChoices
            ? `${library.length} saved ${matchup} build${library.length === 1 ? "" : "s"} available.`
            : `No saved ${matchup} builds available yet.`}
        </p>
      </div>

      {target ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-2.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            iconLeft={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
            aria-label={`Clear ${matchup} build`}
            onClick={() => onClear(matchup)}
            className="text-text-muted"
          >
            Clear
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function SelectedTargetSummary({ target }: { target: GhostTarget }) {
  const duration = target.steps.reduce((max, step) => Math.max(max, step.t), 0);

  return (
    <div className="min-w-0 rounded-md border border-success/30 bg-success/10 px-2.5 py-2" aria-live="polite">
      <p
        className="break-words text-caption font-semibold text-text [overflow-wrap:anywhere]"
        title={target.name}
      >
        {target.name}
      </p>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-micro text-text-muted">
        <span>{target.steps.length} timed step{target.steps.length === 1 ? "" : "s"}</span>
        <span aria-hidden>{"\u00b7"}</span>
        <span className="inline-flex items-center gap-1 tabular-nums">
          <TimerReset className="h-3.5 w-3.5" aria-hidden />
          through {formatDuration(duration)}
        </span>
      </div>
    </div>
  );
}

function assignedCount(loadout: GhostBuildConfig): number {
  return Object.values(loadout.slots).filter(Boolean).length;
}

function sameTarget(a: GhostTarget, b: GhostTarget): boolean {
  if (a.name !== b.name || a.steps.length !== b.steps.length) return false;
  return a.steps.every((step, index) => {
    const other = b.steps[index];
    return Boolean(
      other
      && step.name === other.name
      && step.t === other.t
      && step.supply === other.supply,
    );
  });
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
