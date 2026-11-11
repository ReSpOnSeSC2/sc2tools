import { absoluteUrl } from "@/lib/seo/absoluteUrl";
import openersV1 from "./reportCardOpeners.v1.json";
import { REPORT_CARD_PATH } from "./reportCardRoute";
import type { ReportCardModel } from "./reportSharing";

const VERSION = 1;
const REPORT_TYPE = 1;
const TOTALS = 1;
const OPENER = 2;
const MACRO = 4;
const SECTION_MASK = TOTALS | OPENER | MACRO;
const MAX_GAMES = 999;
const MAX_FRAGMENT_LENGTH = 59;
const MATCHUPS = ["vs P", "vs T", "vs Z"];
// These indexes are part of the v1 wire format. Keep this table independent of catalog sorting and edits.
const OPENER_INDEX = new Map(openersV1.map((name, index) => [name, index]));

type GameRecord = NonNullable<ReportCardModel["totals"]>;
const inRange = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;

function validRecord(row: GameRecord, minGames = 0): boolean {
  return inRange(row.games, minGames, MAX_GAMES) && inRange(row.wins, 0, row.games)
    && inRange(row.losses, 0, row.games - row.wins);
}

function validMatchups({ matchups, totals }: ReportCardModel): boolean {
  const labels = new Set<string>();
  let wins = 0;
  let losses = 0;
  for (const row of matchups) {
    if (!MATCHUPS.includes(row.label) || labels.has(row.label) || !validRecord({ ...row, games: row.wins + row.losses })) return false;
    labels.add(row.label);
    wins += row.wins;
    losses += row.losses;
  }
  return wins + losses <= MAX_GAMES && (!totals || (wins <= totals.wins && losses <= totals.losses));
}

function validOpener(opener: ReportCardModel["opener"], totals: ReportCardModel["totals"]): boolean {
  if (!opener) return true;
  return OPENER_INDEX.has(opener.name) && validRecord(opener, 3) && opener.wins + opener.losses > 0
    && (!totals || (opener.games <= totals.games && opener.wins <= totals.wins && opener.losses <= totals.losses));
}

function validModel(model: ReportCardModel): boolean {
  const { totals, matchups, opener, macro } = model;
  if (!totals && !matchups.length && !opener && !macro) return false;
  return (!totals || validRecord(totals)) && validMatchups(model) && validOpener(opener, totals)
    && (!macro || (inRange(macro.score, 0, 100) && inRange(macro.games, 1, totals?.games ?? MAX_GAMES)));
}

function toBase64url(bytes: readonly number[] | Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function toVarintBytes(values: number[]): number[] {
  // Every field is bounded to 999 or less, so v1 never needs a third byte.
  return values.flatMap(value => value < 128 ? [value] : [(value % 128) + 128, Math.floor(value / 128)]);
}

function recordValues({ games, wins, losses }: GameRecord): number[] {
  return [games, wins, losses];
}

/** Encode only aggregate integers and frozen catalog indexes. No object is serialized. */
export function encodeReportCard(model: ReportCardModel): string | null {
  if (!validModel(model)) return null;
  const { totals, matchups, opener, macro } = model;
  const sections = (totals ? TOTALS : 0) | (opener ? OPENER : 0) | (macro ? MACRO : 0);
  const fields = [matchups.length];
  if (totals) fields.push(...recordValues(totals));
  for (const row of matchups) fields.push(MATCHUPS.indexOf(row.label), row.wins, row.losses);
  if (opener) fields.push(OPENER_INDEX.get(opener.name)!, ...recordValues(opener));
  if (macro) fields.push(macro.score, macro.games);
  return toBase64url([VERSION, REPORT_TYPE, sections, ...toVarintBytes(fields)]);
}

class ReportCardReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(): number {
    const first = this.bytes[this.offset++];
    if (first === undefined) throw new Error("Truncated card");
    if (first < 128) return first;
    const second = this.bytes[this.offset++];
    if (second === undefined || second === 0 || second >= 128) throw new Error("Invalid card varint");
    return first - 128 + second * 128;
  }

  record(): GameRecord {
    return { games: this.read(), wins: this.read(), losses: this.read() };
  }

  get done(): boolean {
    return this.offset === this.bytes.length;
  }
}

function readReportCard(reader: ReportCardReader): ReportCardModel | null {
  if (reader.read() !== VERSION || reader.read() !== REPORT_TYPE) return null;
  const sections = reader.read();
  const matchupCount = reader.read();
  if (sections > SECTION_MASK || matchupCount > MATCHUPS.length) return null;
  const totals = sections & TOTALS ? reader.record() : null;
  const matchups = Array.from({ length: matchupCount }, () => ({
    label: MATCHUPS[reader.read()], wins: reader.read(), losses: reader.read(),
  }));
  const opener = sections & OPENER ? { name: openersV1[reader.read()], ...reader.record() } : null;
  const macro = sections & MACRO ? { score: reader.read(), games: reader.read() } : null;
  const model = { totals, matchups, opener, macro };
  return reader.done && validModel(model) ? model : null;
}

/** The fragment is untrusted. Reject noncanonical encodings as well as invalid fields. */
export function decodeReportCard(fragment: string): ReportCardModel | null {
  if (!fragment || fragment.length > MAX_FRAGMENT_LENGTH || !/^[A-Za-z0-9_-]+$/.test(fragment)) return null;
  try {
    const bytes = Uint8Array.from(atob(fragment.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
    if (toBase64url(bytes) !== fragment) return null;
    return readReportCard(new ReportCardReader(bytes));
  } catch {
    return null;
  }
}

export function reportCardLink(model: ReportCardModel): string | null {
  const fragment = encodeReportCard(model);
  return fragment ? absoluteUrl(`${REPORT_CARD_PATH}#${fragment}`) : null;
}
