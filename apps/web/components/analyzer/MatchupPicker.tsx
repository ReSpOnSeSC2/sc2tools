"use client";

import { useId, useMemo } from "react";
import { useApi } from "@/lib/clientApi";
import {
  normalizeRaceCode,
  useFilters,
  withMyRace,
  withOppRace,
  type RaceCode,
} from "@/lib/filterContext";
import { coerceRace } from "@/lib/race";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";

type OppChoice = "all" | RaceCode;

const OPP_OPTIONS: ReadonlyArray<SegmentedOption<OppChoice>> = [
  { value: "all", label: "All", ariaLabel: "All matchups", title: "Every opponent race" },
  { value: "P", label: "vs P", ariaLabel: "vs Protoss", title: "Only games against Protoss" },
  { value: "T", label: "vs T", ariaLabel: "vs Terran", title: "Only games against Terran" },
  { value: "Z", label: "vs Z", ariaLabel: "vs Zerg", title: "Only games against Zerg" },
];

/** Shown only while Random is the chosen opponent race (set in Strategies). */
const OPP_RANDOM: SegmentedOption<OppChoice> = {
  value: "R",
  label: "vs R",
  ariaLabel: "vs Random",
  title: "Only games against Random",
};

/** Races a game can be played as, in display order, keyed to the API's names. */
const PLAYABLE_RACES = [
  { code: "P", name: "Protoss" },
  { code: "T", name: "Terran" },
  { code: "Z", name: "Zerg" },
] as const;

/** Slice of /v1/random-summary this control reads. */
type RaceSplitResponse = {
  perRace?: Partial<Record<"Protoss" | "Terran" | "Zerg", { games?: number }>>;
};

/**
 * The races you have games as, from your whole history. One small
 * aggregation per visit: the answer is cached for the session and not
 * refetched on focus or when a second picker mounts (the phone sheet).
 */
export function usePlayedRaces(): RaceCode[] {
  const { data } = useApi<RaceSplitResponse>("/v1/random-summary", {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    revalidateOnReconnect: false,
  });
  return useMemo(
    () =>
      PLAYABLE_RACES.filter((race) => (data?.perRace?.[race.name]?.games ?? 0) > 0).map(
        (race) => race.code,
      ),
    [data],
  );
}

/**
 * Global matchup filter for the analyzer filter bar: opponent race as
 * All · vs P · vs T · vs Z, plus a "My race" select for players with
 * games as more than one race. Writes `opp_race` / `race` through
 * `withOppRace` / `withMyRace`, the same keys Strategies' selects use,
 * so both always agree, and the choice is remembered across visits.
 */
export function MatchupPicker() {
  const { filters, setFilters } = useFilters();
  const labelId = useId();
  const selectId = useId();
  const played = usePlayedRaces();

  const oppRace = normalizeRaceCode(filters.opp_race);
  const myRace = normalizeRaceCode(filters.race);
  const options = oppRace === "R" ? [...OPP_OPTIONS, OPP_RANDOM] : OPP_OPTIONS;

  // Offer your own race only when it narrows something: more than one
  // race played, or a race already picked (so it can be changed here).
  const raceChoices = useMemo(() => {
    const codes = new Set<RaceCode>(played);
    if (myRace) codes.add(myRace);
    const order: RaceCode[] = ["P", "T", "Z", "R"];
    return order.filter((code) => codes.has(code));
  }, [played, myRace]);
  const showMyRace = played.length > 1 || myRace !== undefined;

  return (
    <div className="inline-flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="inline-flex flex-wrap items-center gap-1.5">
        <span id={labelId} className="text-xs uppercase tracking-wider text-text-dim">
          Matchup
        </span>
        <SegmentedControl
          labelledBy={labelId}
          value={oppRace ?? "all"}
          options={options}
          onChange={(next) =>
            setFilters(withOppRace(filters, next === "all" ? undefined : next))
          }
        />
      </div>
      {showMyRace ? (
        <div className="inline-flex items-center gap-1.5">
          <label htmlFor={selectId} className="text-xs uppercase tracking-wider text-text-dim">
            My race
          </label>
          <span className="inline-block w-32">
            <Select
              id={selectId}
              selectSize="sm"
              className="min-h-11 sm:min-h-0"
              value={myRace ?? ""}
              onChange={(e) => setFilters(withMyRace(filters, e.target.value || undefined))}
            >
              <option value="">Any race</option>
              {raceChoices.map((code) => (
                <option key={code} value={code}>
                  {coerceRace(code)}
                </option>
              ))}
            </Select>
          </span>
        </div>
      ) : null}
    </div>
  );
}
