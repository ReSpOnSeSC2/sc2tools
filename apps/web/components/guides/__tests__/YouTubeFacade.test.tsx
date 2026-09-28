import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { YouTubeFacade } from "@/components/guides/YouTubeFacade";
import { VIDEO_PVZ_STARGATE_GLAIVES } from "@/lib/guides/__fixtures__";

afterEach(cleanup);

describe("YouTubeFacade", () => {
  it("loads no iframe until the play button is clicked", () => {
    const { container } = render(<YouTubeFacade video={VIDEO_PVZ_STARGATE_GLAIVES} />);
    expect(container.querySelector("iframe")).toBeNull();
    const thumb = container.querySelector("img");
    expect(thumb?.getAttribute("loading")).toBe("lazy");
    expect(thumb?.getAttribute("src")).toBe(VIDEO_PVZ_STARGATE_GLAIVES.thumbnailUrl);

    fireEvent.click(
      screen.getByRole("button", { name: `Play ${VIDEO_PVZ_STARGATE_GLAIVES.title} on YouTube` }),
    );
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/YcTMc_Ee11w?autoplay=1&rel=0",
    );
    expect(iframe?.getAttribute("title")).toBe(VIDEO_PVZ_STARGATE_GLAIVES.title);
    expect(iframe?.getAttribute("allow")).toContain("autoplay");
    expect(iframe?.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
  });

  it("always offers a Watch on YouTube link", () => {
    render(<YouTubeFacade video={VIDEO_PVZ_STARGATE_GLAIVES} />);
    const link = screen.getByRole("link", { name: /Watch on YouTube/ });
    expect(link.getAttribute("href")).toBe("https://www.youtube.com/watch?v=YcTMc_Ee11w");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("never embeds a URL that is not a youtube-nocookie embed", () => {
    const hostile = { ...VIDEO_PVZ_STARGATE_GLAIVES, embedUrl: "https://evil.example/embed/YcTMc_Ee11w" };
    const { container } = render(<YouTubeFacade video={hostile} />);
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(container.querySelector("iframe")).toBeNull();
  });
});
