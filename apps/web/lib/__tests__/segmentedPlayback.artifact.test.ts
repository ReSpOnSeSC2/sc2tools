// Opt-in verification against an existing local agent bundle. No replay data
// or player names are committed; CI uses the small synthetic fixtures instead.
import { readFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { decodePlaybackSegment, sanitizePlaybackManifest } from "../segmentedPlayback";

afterEach(() => vi.unstubAllGlobals());
it.skipIf(!process.env.PLAYBACK_ARTIFACT_MANIFEST)("preserves every channel and lifecycle in the real agent artifact", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const path = process.env.PLAYBACK_ARTIFACT_MANIFEST!;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const artifactId = basename(path).replace(/^manifest-/, "").replace(/\.json$/, "");
  const manifest = sanitizePlaybackManifest({ ok: true, artifactId, manifest: raw });
  expect(manifest).not.toBeNull();
  let lifecycle: unknown;
  let terminalShots = 0;
  for (const entry of manifest!.segments) {
    const bytes = new Uint8Array(readFileSync(join(dirname(path), `${entry.sha256}.json`)));
    const playback = await decodePlaybackSegment(bytes, manifest!, entry);
    const native = JSON.parse(new TextDecoder().decode(bytes)).playback;
    for (const kind of ["units", "buildings"] as const) {
      expect(playback[kind].map(entity => entity.id)).toEqual(native[kind].map((entity: { id: unknown }) => entity.id));
      for (const entity of playback[kind]) terminalShots += (entity.attacks ?? []).filter(t => t === entity.died).length;
    }
    const current = [playback.units.map(({ id, born, died, forms, hidden }) => ({ id, born, died, forms, hidden })),
      playback.buildings.map(({ id, t, died, forms, hidden }) => ({ id, t, died, forms, hidden }))];
    if (lifecycle) expect(current).toEqual(lifecycle);
    else lifecycle = current;
    expect(playback.gameLength).toBe(manifest!.gameLength);
  }
  // The Long Lockdown regression contains an observed same-loop final shot.
  if (manifest!.sourceArtifactSha256.startsWith("45b8bed4")) expect(terminalShots).toBeGreaterThan(0);
}, 30_000);
