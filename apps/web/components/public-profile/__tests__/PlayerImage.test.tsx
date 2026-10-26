// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PUBLIC_PLAYER, playerEnvelope } from "../__fixtures__/publicPlayer";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/publicPlayer", () => ({ fetchPublicPlayer: mocks.fetch }));
import { PlayerImageCard, playerImageData, playerImageOptions, renderPlayerImage } from "../PlayerImage";
import { GET } from "@/app/players/[player]/panel.png/route";
const pngSize = (buffer: Buffer) => [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
afterEach(() => { mocks.fetch.mockReset(); vi.unstubAllEnvs(); });
describe("public channel panel", () => {
  it.each([100, 160] as const)("renders a real 320x%s PNG in both themes and every style", async height => {
    mocks.fetch.mockResolvedValue({ status: 200, data: playerEnvelope({ ...PUBLIC_PLAYER, sections: { ...PUBLIC_PLAYER.sections!, showMmrHistory: true }, mmrHistory: [{ date: "2026-10-19T00:00:00Z", mmr: 4200, games: 10 }], featuredBuild: { slug: "public-build", title: "A deliberate public build", matchup: "PvT", votes: 3 } }) });
    for (const theme of ["light", "dark"] as const) for (const style of ["record", "build", "mmr"] as const) {
      const response = await renderPlayerImage(PUBLIC_PLAYER.handle, { height, theme, style });
      const png = Buffer.from(await response.arrayBuffer());
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); expect(pngSize(png)).toEqual([320, height]);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    }
  });
  it("checks current admission before even a previously rendered bitmap can be reused", async () => {
    vi.stubEnv("COMMUNITY_REVALIDATE_SECRET", "configured-fixture");
    const options = { height: 160 as const, style: "record" as const, theme: "dark" as const };
    mocks.fetch.mockResolvedValueOnce({ status: 200, data: playerEnvelope() })
      .mockResolvedValueOnce({ status: 404, data: null }).mockResolvedValueOnce({ status: 503, data: null }).mockRejectedValueOnce(new Error("private lookup detail"));
    const personal = Buffer.from(await (await renderPlayerImage(PUBLIC_PLAYER.handle, options)).arrayBuffer());
    const hidden = Buffer.from(await (await renderPlayerImage(PUBLIC_PLAYER.handle, options)).arrayBuffer());
    const missing = Buffer.from(await (await renderPlayerImage("unrelated-private-handle", options)).arrayBuffer());
    const unavailable = Buffer.from(await (await renderPlayerImage("unavailable-handle", options)).arrayBuffer());
    expect(hidden.equals(personal)).toBe(false); expect(missing.equals(hidden)).toBe(true);
    expect(unavailable.equals(hidden)).toBe(true); expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });
  it("makes archive-only images neutral even if an unexpected profile value accompanies them", async () => {
    mocks.fetch.mockResolvedValue({ status: 200, data: { ...playerEnvelope(), archiveOnly: true } });
    const response = await GET(new Request("https://sc2tools.test/players/any/panel.png?height=100&theme=light&style=mmr"), { params: Promise.resolve({ player: "any" }) });
    expect(pngSize(Buffer.from(await response.arrayBuffer()))).toEqual([320, 100]);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
  it("never includes identity, MMR or counts in neutral image data or text", () => {
    const neutral = playerImageData(null, "record");
    const text = renderToStaticMarkup(<PlayerImageCard card={neutral} options={{ height: 160, theme: "dark", style: "record" }} />);
    expect(text).not.toContain(PUBLIC_PLAYER.displayName); expect(text).not.toMatch(/12 wins|4200|20 games/);
    expect(neutral).toEqual(playerImageData(null, "mmr"));
  });
  it("requires the separate MMR section even when a history field unexpectedly arrives", () => {
    const card = playerImageData({ ...PUBLIC_PLAYER, mmrHistory: [{ date: "2026-10-19", mmr: 9999, games: 10 }] }, "mmr");
    expect(card.headline).toBe("MMR history not shared"); expect(JSON.stringify(card)).not.toContain("9999");
  });
  it("uses bounded known dimensions/options for arbitrary query input", () => {
    expect(playerImageOptions(new URLSearchParams("height=999999&style=private&theme=secret"))).toEqual({ height: 160, style: "record", theme: "dark" });
  });
});
