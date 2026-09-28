import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GuideVideoRow } from "@/components/guides/GuideVideoRow";
import { GuideVideoSection } from "@/components/guides/GuideVideoSection";
import { embeddedVideoJsonLd, videoJsonLd } from "@/components/guides/guideSeo";
import { VIDEO_PVZ_CARRIER_RUSH, VIDEO_PVZ_STARGATE_GLAIVES } from "@/lib/guides/__fixtures__";
import type { GuideVideo } from "@/lib/guides/types";

/** An admin-added video the channel feed hasn't listed yet: no upload date. */
const UNDATED: GuideVideo = { ...VIDEO_PVZ_STARGATE_GLAIVES, publishedAt: null };

afterEach(cleanup);

describe("videos without an upload date", () => {
  it("emit no VideoObject (uploadDate is required and never guessed)", () => {
    expect(videoJsonLd(UNDATED)).toBeNull();
    expect(videoJsonLd({ ...VIDEO_PVZ_STARGATE_GLAIVES, publishedAt: "not a date" })).toBeNull();
    expect(embeddedVideoJsonLd([UNDATED])).toEqual([]);
    expect(videoJsonLd(VIDEO_PVZ_STARGATE_GLAIVES)).toMatchObject({
      uploadDate: VIDEO_PVZ_STARGATE_GLAIVES.publishedAt,
    });
  });

  it("still embed on the page, without a 'Published' line", () => {
    render(<GuideVideoSection videos={[UNDATED, { ...VIDEO_PVZ_CARRIER_RUSH, publishedAt: null }]} />);
    expect(screen.getByRole("heading", { name: UNDATED.title })).toBeTruthy();
    expect(screen.queryByText(/Published/)).toBeNull();
    const more = screen.getByRole("link", { name: VIDEO_PVZ_CARRIER_RUSH.title });
    expect(more.parentElement?.textContent).not.toContain("—");
  });

  it("show just 'YouTube' under the thumbnail in a video row", () => {
    render(<GuideVideoRow title="Latest PvZ videos" videos={[UNDATED]} />);
    const link = screen.getByRole("link", { name: new RegExp(UNDATED.title) });
    expect(link.textContent).toContain("YouTube");
    expect(link.textContent).not.toContain("—");
  });
});
