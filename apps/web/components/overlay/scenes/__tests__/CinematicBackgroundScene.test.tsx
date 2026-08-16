import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  STREAM_BACKGROUNDS,
  STREAM_BACKGROUND_IDS,
  getStreamBackground,
  isStreamBackgroundId,
} from "@/lib/streamBackgrounds";
import { CinematicBackgroundScene } from "../CinematicBackgroundScene";

afterEach(cleanup);

describe("stream background catalog", () => {
  it("contains seven unique stable scene IDs with matching 1080p and 4K assets", () => {
    expect(STREAM_BACKGROUNDS).toHaveLength(7);
    expect(new Set(STREAM_BACKGROUND_IDS).size).toBe(7);

    for (const background of STREAM_BACKGROUNDS) {
      expect(background.src1080).toMatch(
        /^\/stream-backgrounds\/1080p\/[\w-]+\.jpg$/,
      );
      expect(background.src4k).toMatch(
        /^\/stream-backgrounds\/4k\/[\w-]+\.jpg$/,
      );
      expect(background.src1080.split("/").at(-1)).toBe(
        background.src4k.split("/").at(-1),
      );
      expect(getStreamBackground(background.id)).toBe(background);
    }
  });

  it("recognizes catalog IDs without accepting arbitrary route text", () => {
    expect(isStreamBackgroundId("frontier-cantina")).toBe(true);
    expect(isStreamBackgroundId("../../frontier-cantina")).toBe(false);
    expect(isStreamBackgroundId("starting-soon")).toBe(false);
  });
});

describe("CinematicBackgroundScene", () => {
  it.each(STREAM_BACKGROUNDS)(
    "renders $id edge-to-edge with responsive image candidates",
    (background) => {
      const { container } = render(
        <CinematicBackgroundScene backgroundId={background.id} />,
      );
      const canvas = container.querySelector(
        '[data-scene-kind="cinematic-background"]',
      ) as HTMLElement | null;
      const image = container.querySelector("img") as HTMLImageElement | null;
      const source = container.querySelector("source") as HTMLSourceElement | null;

      expect(canvas?.dataset.backgroundId).toBe(background.id);
      expect(canvas?.style.width).toBe("100vw");
      expect(canvas?.style.height).toBe("100vh");
      expect(image?.getAttribute("src")).toBe(background.src1080);
      expect(image?.getAttribute("srcset")).toContain(background.src4k);
      expect(image?.style.objectFit).toBe("cover");
      expect(image?.style.objectPosition).toBe(background.objectPosition);
      expect(source?.getAttribute("media")).toBe("(min-width: 2560px)");
      expect(source?.getAttribute("srcset")).toBe(`${background.src4k} 3840w`);
    },
  );

  it("is decorative and contains no baked UI text", () => {
    const { container } = render(
      <CinematicBackgroundScene backgroundId="frontier-cantina" />,
    );
    expect(container.textContent).toBe("");
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(
      container.querySelector('[aria-hidden="true"]'),
    ).toBeTruthy();
  });
});
