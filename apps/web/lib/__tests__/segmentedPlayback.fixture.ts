import { createHash } from "node:crypto";
import { sanitizePlaybackManifest } from "../segmentedPlayback";

export const fidelity = { positions: "engine", paths: "observed", creep: "observed", attacks: "observed", effects: "observed", complete: true, positionError: .15, sampleSeconds: .089 };
export const makePlayback = () => ({
  v: 7, terminalAttackInclusive: true, mapName: "Test LE", gameLength: 240,
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, fidelity,
  units: [{ id: "12", owner: "me", name: "Stalker", born: 0, died: 220, wp: [0, 10, 10, 60, 20, 20], attacks: [60, 220], aim: [220, 40, 40], hidden: [80, 85], forms: [{ t: 0, name: "Stalker" }] }],
  buildings: [{ id: "13", owner: "opp", name: "Barracks", t: 0, died: null, x: 70, y: 70, moves: [0, 70, 70], hidden: [100, 101] }],
  stats: { me: [[0, 0, 8, 8], [240, 1000, 30, 50]], opp: [[0, 0, 8, 8], [240, 1000, 30, 50]] },
  resources: [], battles: [], spawns: [], casts: [], effects: [],
  creep: { encoding: "rle", width: 10, height: 10, frames: [{ t: 0, runs: [0, 1] }] },
});

export function makeSegmentFixture(change?: (playback: ReturnType<typeof makePlayback>) => void) {
  const playback = makePlayback();
  change?.(playback);
  const bytes = Array.from({ length: 4 }, (_, index) => new TextEncoder().encode(JSON.stringify({
    schema: "sc2tools-playback-segment-v1", replaySha256: "a".repeat(64), index,
    start: index * 60, end: (index + 1) * 60, playback,
  })));
  const raw = { ok: true, artifactId: "b".repeat(64), manifest: {
    schema: "sc2tools-playback-manifest-v1", replaySha256: "a".repeat(64), sourceArtifactSha256: "c".repeat(64),
    mapName: playback.mapName, gameLength: 240, fidelity, segments: bytes.map((value, index) => ({
      index, start: index * 60, end: (index + 1) * 60, sizeBytes: value.length,
      sha256: createHash("sha256").update(value).digest("hex"), points: 3,
    })),
  } };
  return { raw, manifest: sanitizePlaybackManifest(raw)!, bytes, playback };
}
