// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/components/guides/og/readPublicOg", () => ({ readPublicOg: mocks.read }));
import Image, { dynamic, revalidate } from "./opengraph-image";
afterEach(() => { mocks.read.mockReset(); vi.unstubAllEnvs(); });
it("renders a real Community PNG without output caching even when optional purge is configured", async () => {
  vi.stubEnv("COMMUNITY_REVALIDATE_SECRET", "synthetic-purge-offline");
  mocks.read.mockResolvedValue({ slug: "synthetic-public-build", title: "Synthetic published opening", authorName: "Public author", votes: 1, matchup: "PvZ", build: {} });
  const response = await Image({ params: Promise.resolve({ slug: "synthetic-public-build" }) });
  expect(dynamic).toBe("force-dynamic"); expect(revalidate).toBe(0);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  const png = Buffer.from(await response.arrayBuffer());
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
});
