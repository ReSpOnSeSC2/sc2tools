import { sanitizeMapPlayback, type MapPlayback } from "../mapReplay";
import { FIGHTS_PER_DAY, PRACTICE_DAYS } from "./rules";

export const DAILY_ROOT = "/daily/v1";
export const DAILY_VERSION = 1;
export const CLIP_SECONDS = 10;
const MAX_SIDE = 64;
const MAX_UNITS = 160;
const MAX_POINTS = 128;
export const MAX_PACK_BYTES = 1_500_000;
const DIGEST = /^[a-f0-9]{64}$/;

export type DailyUnit = {
  side: 0 | 1;
  unit: string;
  from: number;
  until: number | null;
  path: number[];
  shots?: number[];
  aim?: number[];
  forms?: { at: number; unit: string }[];
  gaps?: number[];
  hiddenAtEnd?: true;
};
export type DailyFight = {
  width: number;
  height: number;
  units: DailyUnit[];
  losses: [blue: number, red: number];
  terrain: boolean;
};
export type DailyPack = { version: 1; fights: DailyFight[] };
export type DailyIndex = { version: 1; days: Record<string, string>; practice: string[] };

type Row = Record<string, unknown>;

function row(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function keys(value: Row, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function allowedRow(value: unknown, allowed: readonly string[]): Row | null {
  const candidate = row(value);
  return candidate && keys(candidate, allowed) ? candidate : null;
}

function numberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && value >= min && value <= max;
}

function name(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Za-z0-9]{0,39}$/.test(value);
}

function times(value: unknown, from: number, until: number): value is number[] {
  return Array.isArray(value) && value.length <= MAX_POINTS &&
    value.every((time, index) => numberIn(time, from, until) && (index === 0 || time > value[index - 1]));
}

function track(value: unknown, min: number, max: number, width: number, height: number): value is number[] {
  if (!Array.isArray(value) || value.length % 3 !== 0 || value.length > MAX_POINTS * 3) return false;
  for (let i = 0; i < value.length; i += 3) {
    if (!numberIn(value[i], min, max) || (i && value[i] <= value[i - 3])) return false;
    if (!numberIn(value[i + 1], 0, width) || !numberIn(value[i + 2], 0, height)) return false;
  }
  return true;
}

function formsValid(value: unknown, from: number, until: number): boolean {
  if (!Array.isArray(value) || value.length > MAX_POINTS) return false;
  const forms = value.map(row);
  return forms.every(form => form && keys(form, ["at", "unit"]) && name(form.unit)) &&
    times(forms.map(form => form?.at), from, until);
}

function aimsMatchShots(aim: readonly number[], shots: unknown): boolean {
  if (!Array.isArray(shots)) return false;
  const times = new Set(shots);
  return aim.every((time, index) => index % 3 !== 0 || times.has(time));
}

function timingValid(value: Row, width: number, height: number, from: number, until: number): boolean {
  if (!track(value.path, from, until, width, height) || !value.path.length || value.path[0] !== from) return false;
  if (value.shots !== undefined && !times(value.shots, from, until)) return false;
  if (value.aim !== undefined && !validAim(value, width, height, from, until)) return false;
  return validLifecycle(value, from, until);
}

function validAim(value: Row, width: number, height: number, from: number, until: number): boolean {
  return track(value.aim, from, until, width, height) && aimsMatchShots(value.aim, value.shots);
}

function validLifecycle(value: Row, from: number, until: number): boolean {
  if (value.forms !== undefined && !formsValid(value.forms, from, until)) return false;
  if (value.hiddenAtEnd !== undefined && (value.hiddenAtEnd !== true || value.until !== null)) return false;
  return value.gaps === undefined || (times(value.gaps, from, until) && value.gaps.length % 2 === 0);
}

function validUnit(value: unknown, width: number, height: number): value is DailyUnit {
  const unit = allowedRow(value, ["side", "unit", "from", "until", "path", "shots", "aim", "forms", "gaps", "hiddenAtEnd"]);
  if (!unit) return false;
  if ((unit.side !== 0 && unit.side !== 1) || !name(unit.unit) || !numberIn(unit.from, 0, CLIP_SECONDS)) return false;
  if (unit.until !== null && (!numberIn(unit.until, unit.from, CLIP_SECONDS) || unit.until <= unit.from)) return false;
  return timingValid(unit, width, height, unit.from, unit.until ?? CLIP_SECONDS);
}

function validLosses(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(n => Number.isInteger(n) && numberIn(n, 0, 100_000)) &&
    value[0] + value[1] > 0;
}

export function isOpeningUnit(unit: DailyUnit): boolean {
  return unit.from === 0 && unit.gaps?.[0] !== 0;
}

export function isDailyFight(value: unknown): value is DailyFight {
  const fight = allowedRow(value, ["width", "height", "units", "losses", "terrain"]);
  if (!fight) return false;
  const { width, height, units } = fight;
  if (!numberIn(width, 1, MAX_SIDE) || !numberIn(height, 1, MAX_SIDE)) return false;
  if (!Array.isArray(units) || units.length > MAX_UNITS || !units.every(unit => validUnit(unit, width, height))) return false;
  const opening = units.filter(isOpeningUnit);
  return opening.some(unit => unit.side === 0) && opening.some(unit => unit.side === 1) &&
    validLosses(fight.losses) && typeof fight.terrain === "boolean";
}

export function readDailyPack(value: unknown): DailyPack | null {
  const pack = row(value);
  if (!pack || !keys(pack, ["version", "fights"]) || pack.version !== DAILY_VERSION) return null;
  const fights = pack.fights;
  return Array.isArray(fights) && fights.length === FIGHTS_PER_DAY && fights.every(isDailyFight)
    ? { version: DAILY_VERSION, fights }
    : null;
}

function isDailyDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

export function readDailyIndex(value: unknown): DailyIndex | null {
  const index = row(value);
  if (!index || !keys(index, ["version", "days", "practice"]) || index.version !== DAILY_VERSION) return null;
  const days = row(index.days), practice = index.practice;
  if (!days || !Array.isArray(practice) || practice.length !== PRACTICE_DAYS || !practice.every(isDailyDigest)) return null;
  const entries = Object.entries(days);
  if (entries.length > 366 || entries.some(([day, hash]) => !/^[1-9][0-9]{0,5}$/.test(day) || !isDailyDigest(hash))) return null;
  return { version: DAILY_VERSION, days: Object.fromEntries(entries) as Record<string, string>, practice };
}

export function packDirectory(hash: string, root = DAILY_ROOT): string {
  return root + "/packs/" + hash;
}

function playbackGaps(unit: DailyUnit): number[] | undefined {
  // Replay gaps are half-open. Keep an offscreen survivor hidden on the frozen final frame.
  return unit.hiddenAtEnd ? [...(unit.gaps ?? []), CLIP_SECONDS, CLIP_SECONDS + 1] : unit.gaps;
}

export function fightPlayback(fight: DailyFight): MapPlayback | null {
  return sanitizeMapPlayback({
    v: 7,
    gameLength: CLIP_SECONDS,
    bounds: { minX: 0, minY: 0, maxX: fight.width, maxY: fight.height },
    fidelity: { positions: "engine", paths: "observed", attacks: "observed", creep: "estimated" },
    terminalAttackInclusive: true,
    units: fight.units.map(unit => ({
      owner: unit.side === 0 ? "me" : "opp",
      name: unit.unit,
      born: unit.from,
      died: unit.until,
      wp: unit.path,
      attacks: unit.shots,
      aim: unit.aim,
      forms: unit.forms?.map(form => ({ t: form.at, name: form.unit })),
      hidden: playbackGaps(unit),
    })),
  });
}
