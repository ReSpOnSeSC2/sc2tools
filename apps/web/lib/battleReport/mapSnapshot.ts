import { shareReportPalette } from "@/lib/shareReportPalette";
import {
  buildingPositionAt, buildingVisibleAt, projectX, projectY, unitMaxSpeed,
  unitPositionAt, unitVisibleAt, worldProjection, type MapPlayback,
} from "@/lib/mapReplay";
import { snapshotRace } from "@/components/battleReport/snapshotRace";

type Point = { x: number; y: number };
type Side = "me" | "opp";
type Marker = Point & { side: Side; structure: boolean };

const RACE_COLORS: Readonly<Record<string, string>> = { Protoss: shareReportPalette.protoss, Terran: shareReportPalette.terran, Zerg: shareReportPalette.zerg };
const MAX_PER_SIDE = 80;

export function snapshotColor(race: string | null | undefined, side: Side): string {
  return RACE_COLORS[snapshotRace(race, side).name] ?? (side === "me" ? shareReportPalette.owner : shareReportPalette.opponent);
}

/** Bounded replay coordinates only. No entity names, IDs or account data leave the recording. */
export function snapshotPositions(playback: MapPlayback, time: number, width: number, height: number, fight?: Point | null) {
  if (!Number.isFinite(time) || time < 0 || time > playback.gameLength || playback.fidelity?.complete === false) return null;
  const { bounds } = playback;
  const projection = worldProjection(bounds, width, height);
  const observed = playback.fidelity?.positions === "engine";
  const project = (position: Point) => ({
    x: projectX(bounds, projection, position.x),
    y: projectY(bounds, projection, position.y),
  });
  const bySide: Record<Side, Marker[]> = { me: [], opp: [] };
  for (const building of playback.buildings) {
    const points = bySide[building.owner];
    if (points.length >= MAX_PER_SIDE || !buildingVisibleAt(building, time)) continue;
    points.push({ ...project(buildingPositionAt(building, time, observed)), side: building.owner, structure: true });
  }
  for (const unit of playback.units) {
    const points = bySide[unit.owner];
    if (points.length >= MAX_PER_SIDE || !unitVisibleAt(unit, time)) continue;
    const position = unitPositionAt(unit.wp, time, unitMaxSpeed(unit.name, observed));
    if (position) points.push({ ...project(position), side: unit.owner, structure: false });
  }
  const points = [...bySide.me, ...bySide.opp];
  if (!points.length) return null;
  const battle = fight ?? playback.battles.find((row) => Math.abs(row.t - time) <= 10);
  return {
    points,
    terrain: { x: projection.ox, y: projection.oy, width: (bounds.maxX - bounds.minX) * projection.k, height: (bounds.maxY - bounds.minY) * projection.k },
    fight: battle ? project(battle) : null,
  };
}
