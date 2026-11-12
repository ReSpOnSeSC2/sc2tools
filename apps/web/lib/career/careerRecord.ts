import { type SelectedHeader } from "./headerRows";

const DAY_MS = 86_400_000;
const GAP_DAYS = 90;

const RACES = ["Terran", "Protoss", "Zerg", "Random", "Unknown"] as const;
type Race = (typeof RACES)[number];

const ERAS = {
  WoL: "Wings of Liberty",
  HotS: "Heart of the Swarm",
  LotV: "Legacy of the Void",
} as const;
type Era = (typeof ERAS)[keyof typeof ERAS] | "Unknown";

type Day = { day: string; epoch: number; year: number; weekday: number };
type CareerGame = Day & {
  map: string | null;
  race: Race;
  era: Era;
  duration: number | null;
};

type Counts<T extends string> = Map<T, number>;
type EraRecord = { era: Era; firstDay: string; lastDay: string; games: number };
type YearRecord = { year: number; games: number; map: string | null; mapGames: number; races: Array<{ race: Race; games: number }> };
type Gap = { days: number; after: string; before: string };

function utcDay(date: Date): Day {
  const [day] = date.toISOString().split("T");
  const epoch = Math.floor(date.getTime() / DAY_MS) * DAY_MS;
  return { day, epoch, year: date.getUTCFullYear(), weekday: date.getUTCDay() };
}

function eraFor(expansion: string | null): Era {
  if (expansion === "WoL" || expansion === "HotS" || expansion === "LotV") return ERAS[expansion];
  return "Unknown";
}

function careerGame({ me, header }: SelectedHeader): CareerGame {
  const race = me.selectedRace || me.race;
  return {
    ...utcDay(new Date(header.date)),
    map: header.map?.trim() || null,
    race: RACES.find((value) => value === race) ?? "Unknown",
    era: eraFor(header.expansion),
    duration: Number.isFinite(header.durationSec) && header.durationSec > 0 ? header.durationSec : null,
  };
}

function increment<T extends string>(counts: Counts<T>, value: T) {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function mostPlayed(counts: Counts<string>): [string | null, number] {
  let top: [string | null, number] = [null, 0];
  for (const [map, games] of counts) {
    if (games > top[1] || (games === top[1] && top[0] !== null && map < top[0])) top = [map, games];
  }
  return top;
}

function recordEras(games: CareerGame[]): EraRecord[] {
  const records = new Map<Era, EraRecord>();
  for (const { era, day } of games) {
    const record = records.get(era);
    if (record) {
      record.lastDay = day;
      record.games++;
    } else records.set(era, { era, firstDay: day, lastDay: day, games: 1 });
  }
  return [...records.values()];
}

function recordYears(games: CareerGame[]): YearRecord[] {
  const years = new Map<number, { games: number; maps: Counts<string>; races: Counts<Race> }>();
  for (const game of games) {
    const year = years.get(game.year) ?? { games: 0, maps: new Map(), races: new Map() };
    year.games++;
    if (game.map) increment(year.maps, game.map);
    increment(year.races, game.race);
    years.set(game.year, year);
  }
  return [...years].map(([year, { games: total, maps, races }]) => {
    const [map, mapGames] = mostPlayed(maps);
    return {
      year, games: total, map, mapGames,
      races: RACES.flatMap((race) => {
        const games = races.get(race);
        return games ? [{ race, games }] : [];
      }),
    };
  });
}

function recordedGaps(games: CareerGame[]): Gap[] {
  const gaps: Gap[] = [];
  for (let index = 1; index < games.length; index++) {
    const after = games[index - 1];
    const before = games[index];
    const days = (before.epoch - after.epoch) / DAY_MS;
    if (days >= GAP_DAYS) gaps.push({ days, after: after.day, before: before.day });
  }
  return gaps;
}

export function careerRecord(rows: SelectedHeader[]) {
  if (!rows.length) return null;
  const games = [...rows].sort((a, b) => Date.parse(a.header.date) - Date.parse(b.header.date)).map(careerGame);
  const days = [0, 0, 0, 0, 0, 0, 0];
  let seconds = 0;
  let timedGames = 0;
  for (const game of games) {
    days[game.weekday]++;
    if (game.duration !== null) {
      seconds += game.duration;
      timedGames++;
    }
  }
  const busiest = Math.max(...days);
  return {
    first: games[0], games: games.length, seconds, timedGames,
    eras: recordEras(games), years: recordYears(games), gaps: recordedGaps(games),
    weekdays: days.flatMap((games, day) => games === busiest ? [day] : []), weekdayGames: busiest,
  };
}

export type CareerRecord = NonNullable<ReturnType<typeof careerRecord>>;
