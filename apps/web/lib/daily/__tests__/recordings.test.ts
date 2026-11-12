import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, test } from "vitest";
import { recordingFights, sha } from "../../../scripts/daily/recordings.mjs";
import { decodePlaybackSegment, MAX_SEGMENT_BYTES, sanitizePlaybackManifest } from "../../segmentedPlayback";
import { selectFights } from "../buildPack";

const fidelity = { positions: "engine", paths: "observed", attacks: "observed", effects: "observed",
  creep: "observed", complete: true, sampleSeconds: 0.179, positionError: 0.2 };
const replaySha256 = "b".repeat(64);

function unit(owner: "me" | "opp", index: number, died: number | null) {
  const x = owner === "me" ? 45 : 54;
  const y = 30 + index;
  return { id: index, owner, name: "Marine", born: 10, died, wp: [10, x, y, 35, x, y],
    attacks: [20], aim: [20, 50, 33] };
}

function segment() {
  return {
    schema: "sc2tools-playback-segment-v1", replaySha256, index: 0, start: 0, end: 60,
    playback: { v: 7, gameLength: 60, mapName: "Private Layout", fidelity,
      bounds: { minX: 0, minY: 0, maxX: 80, maxY: 60 }, units: [
        unit("me", 1, 24), unit("me", 2, null), unit("opp", 3, 23), unit("opp", 4, 23.5),
        unit("opp", 5, 24.5), unit("opp", 6, 25), unit("opp", 7, 25.5), unit("opp", 8, null),
      ],
    },
  };
}

test("verifies a Recorded segment and crops its local layout before exposing public fields", async () => {
  const folder = await mkdtemp(join(tmpdir(), "sc2-daily-recording-test-"));
  const part = Buffer.from(JSON.stringify(segment())), digest = sha(part);
  const playback = join(folder, digest + ".json"), manifest = join(folder, "manifest.json"), layout = join(folder, "layout.png");
  const helpers = { selectFights, decodePlaybackSegment, MAX_SEGMENT_BYTES, sanitizePlaybackManifest };
  const source = { manifest, layout, era: "after" };
  try {
    await writeFile(playback, part);
    await writeFile(manifest, JSON.stringify({
      schema: "sc2tools-playback-manifest-v1", replaySha256, sourceArtifactSha256: "a".repeat(64),
      mapName: "Private Layout", gameLength: 60, fidelity,
      segments: [{ index: 0, start: 0, end: 60, sizeBytes: part.length, sha256: digest, points: 16 }],
    }));
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "green" } }).png().toFile(layout);

    const iterator = recordingFights(source, helpers);
    const draft = await iterator.next();
    if (draft.done) throw new Error("Expected a recorded fight.");
    expect(draft.value.fight).toMatchObject({ width: 36, height: 24, terrain: true, losses: [250, 50] });
    expect(JSON.stringify(draft.value.fight)).not.toContain("Private Layout");
    expect(JSON.stringify(draft.value.fight)).not.toContain(replaySha256);
    expect(await sharp(await draft.value.terrain()).metadata()).toMatchObject({ format: "webp", width: 360, height: 240 });
    expect((await iterator.next()).done).toBe(true);

    part[part.length - 1] = 32;
    await writeFile(playback, part);
    await expect(recordingFights(source, helpers).next()).rejects.toThrow("integrity check failed");
  } finally {
    for (const file of [playback, manifest, layout]) await rm(file, { force: true });
    await rmdir(folder);
  }
});
