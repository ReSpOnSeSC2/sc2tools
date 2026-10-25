// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderPublicOgImage } from "./PublicOgCard";
import { marketingOg } from "./publicOgData";
import { getIconPath } from "@/lib/sc2-icons";

describe("actual public social image renderer", () => {
  it.each(["try", "download", "fallback"] as const)("renders %s as a real 1200x630 PNG", async kind => {
    const response = await renderPublicOgImage(kind === "fallback" ? null : marketingOg(kind));
    const png = Buffer.from(await response.arrayBuffer());
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(response.headers.get("Cache-Control")).toContain(kind === "fallback" ? "s-maxage=60" : "s-maxage=300");
  });
  it("renders all five local-icon deadline cards with a long public title", async () => {
    const card = { ...marketingOg("try"), kind: "Community build", title: "A two-Stargate opening that preserves its early air commitment through later transitions",
      stepsLabel: "Opening rule deadlines", steps: ["Pylon", "Gateway", "CyberneticsCore", "Stargate", "VoidRay"].map(token => ({ name: token, time: "by 7:00", icon: getIconPath(token) })),
      stats: [{ label: "Net votes", value: "1,234" }] };
    expect(card.steps.every(row => row.icon)).toBe(true);
    const response = await renderPublicOgImage(card);
    const png = Buffer.from(await response.arrayBuffer());
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(png.length).toBeGreaterThan(10_000);
  });
  it("keeps user-published cards uncached when purge is unavailable without affecting their real PNG", async () => {
    const response = await renderPublicOgImage({ ...marketingOg("try"), kind: "Community build" }, false);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const png = Buffer.from(await response.arrayBuffer()); expect(png.readUInt32BE(16)).toBe(1200);
  });
});
