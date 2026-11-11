// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import Image, { dynamic, revalidate } from "./opengraph-image";
import { reportFixtures } from "@/lib/battleReport/__tests__/fixtures";
import { reportPreview } from "@/lib/og/reportSnapshot";
import type { SharedGameAnalysis } from "@/lib/sharedGame";

const TOKEN = "AbCdEfGhIjKlMnOp";
const ANALYSIS: SharedGameAnalysis = {
  game: {
    matchup: "ZvP", myRace: "Zerg", oppRace: "Protoss", map: null, result: "Win", durationSec: 960,
    playedOn: "2026-09-01", myBuild: null, oppStrategy: null, macroScore: 61, apm: null, spq: null,
    playerLabel: "Zerg player", playerMmr: null, playerBand: null,
    opponentLabel: "Protoss opponent", opponentMmr: null, opponentBand: null, matchFormat: "1v1", playerCount: 2,
  },
  macroBreakdown: reportFixtures[3].breakdown ?? null, buildOrder: null, playback: { mode: "none" }, benchmark: null,
};

afterEach(() => vi.unstubAllGlobals());

it("only briefly caches a live PNG and renders an uncached neutral card after revocation", async () => {
  const fetchShare = vi.fn()
    .mockResolvedValueOnce(Response.json(ANALYSIS))
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetchShare);
  const active = await Image({ params: Promise.resolve({ token: TOKEN }) });
  const revoked = await Image({ params: Promise.resolve({ token: TOKEN }) });
  const invalid = await Image({ params: Promise.resolve({ token: "bad" }) });

  expect(dynamic).toBe("force-dynamic");
  expect(revalidate).toBe(0);
  expect(active.headers.get("Cache-Control")).toBe("public, max-age=0, s-maxage=60, must-revalidate, no-transform");
  expect(revoked.headers.get("Cache-Control")).toBe("no-store");
  expect(invalid.headers.get("Cache-Control")).toBe("no-store");
  expect(fetchShare.mock.calls).toEqual(Array.from({ length: 2 }, () => [
    expect.stringContaining(`/v1/shares/${TOKEN}`), expect.objectContaining({ cache: "no-store" }),
  ]));
  expect(reportPreview(ANALYSIS, TOKEN).turningPoint).not.toBeNull();
  const activePng = Buffer.from(await active.arrayBuffer());
  const revokedPng = Buffer.from(await revoked.arrayBuffer());
  const invalidPng = Buffer.from(await invalid.arrayBuffer());
  expect([activePng.readUInt32BE(16), activePng.readUInt32BE(20)]).toEqual([1200, 630]);
  expect(revokedPng.equals(activePng)).toBe(false);
  expect(revokedPng.equals(invalidPng)).toBe(true);
});
