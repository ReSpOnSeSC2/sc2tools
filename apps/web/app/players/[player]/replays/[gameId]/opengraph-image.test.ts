// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import ReplayCardImage from "./opengraph-image";

const mocks = vi.hoisted(() => ({ card: vi.fn(), archive: vi.fn() }));
vi.mock("@/lib/publicReplayCard", () => ({ readPublicReplayCard: mocks.card }));
vi.mock("@/lib/publicReplayIdentity", () => ({ readPublicReplayIdentity: mocks.archive }));

const profile = { handle: "fixture-player", displayName: "Fixture Player" };
const game = { matchup: "PvZ", result: "Victory", map: "Alcyone LE", durationSec: 640, myBuild: "Blink", oppStrategy: "Roach" };

afterEach(() => vi.resetAllMocks());

it.each(["replay", "archive fallback"])("renders the %s as a complete uncached PNG", async (view) => {
  mocks.card.mockResolvedValue({ data: view === "replay" ? { profile, game } : null });
  mocks.archive.mockResolvedValue({ data: { profile, items: [game] } });
  const image = await ReplayCardImage({ params: Promise.resolve({ player: profile.handle, gameId: `r-${"2".padStart(24, "0")}` }) });

  expect(mocks.archive).toHaveBeenCalledTimes(view === "replay" ? 0 : 1);
  expect(image.headers.get("Content-Type")).toBe("image/png");
  expect(image.headers.get("Cache-Control")).toContain("no-store");
  const png = Buffer.from(await image.arrayBuffer());
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
});
