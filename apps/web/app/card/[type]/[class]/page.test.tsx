import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ReportCardPage, { dynamicParams, generateMetadata, generateStaticParams } from "./page";
import { dynamic, dynamicParams as imageDynamicParams, generateStaticParams as imageParams, GET } from "./opengraph-image/route";

vi.mock("@/components/instant/ReportCardViewer", () => ({ ReportCardViewer: () => <p>Card viewer</p> }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("Not found"); } }));
const renderImage = vi.hoisted(() => vi.fn(() => new Response("png")));
vi.mock("@/components/guides/og/PublicOgCard", () => ({ renderPublicOgImage: renderImage }));

const segments = { type: "report", class: "summary" };

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

it("prerenders only the supported enum pairs for the viewer and preview", async () => {
  expect(generateStaticParams()).toEqual([segments, { type: "report", class: "compare" }]);
  expect(dynamicParams).toBe(false);
  expect(imageParams()).toEqual(generateStaticParams());
  expect(imageDynamicParams).toBe(false);
  expect(dynamic).toBe("force-static");
  await expect(ReportCardPage({ params: Promise.resolve({ ...segments, class: "arbitrary" }) })).rejects.toThrow("Not found");
  const request = new Request("https://sc2tools.com/card/report/arbitrary/opengraph-image");
  expect((await GET(request, { params: Promise.resolve({ ...segments, class: "arbitrary" }) })).status).toBe(404);
});

it.each([["summary", "StarCraft II replay report"], ["compare", "StarCraft II replay comparison"]])(
  "uses fixed noindex metadata and image content for %s", async (cardClass, title) => {
    const params = Promise.resolve({ ...segments, class: cardClass });
    const image = `/card/report/${cardClass}/opengraph-image`;
    const metadata = await generateMetadata({ params });
    expect(metadata.robots).toMatchObject({ index: false });
    expect(metadata.alternates?.canonical).toBe(`/card/report/${cardClass}`);
    expect(metadata.openGraph?.images).toEqual([{ url: image, width: 1200, height: 630, alt: title }]);
    expect(metadata.twitter?.images).toEqual([{ url: image, alt: title }]);
    await GET(new Request(`https://sc2tools.com${image}?name=PrivateName`), { params });
    expect(renderImage).toHaveBeenLastCalledWith({
      kind: expect.any(String), title, subtitle: expect.not.stringContaining("PrivateName"), stats: [], steps: [],
    });
  },
);

it.each([
  ["all", "Make yours", "/try"],
  ["off", "Explore SC2 Tools", "/"],
])("keeps the public viewer usable with Instant Analysis set to %s", async (mode, name, href) => {
  vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", mode);
  render(await ReportCardPage({ params: Promise.resolve(segments) }));
  expect(screen.getByText(/numbers are self-reported/)).toBeTruthy();
  expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(href);
});
