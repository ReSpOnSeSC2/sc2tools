import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_OVERLAY_FLAGS, OverlayFlagsContext } from "../overlayFlags";
import { STREAM_BACKGROUNDS } from "@/lib/streamBackgrounds";
import { OverlayScenesSection } from "../OverlayScenesSection";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("OverlayScenesSection virtual sets", () => {
  it("lists all seven stable Browser Source URLs without theme churn", () => {
    render(
      <OverlayScenesSection
        token="overlay-token"
        origin="https://studio.example"
        theme={{ accent: "#abcdef", scale: 1.1 }}
      />,
    );

    expect(screen.getAllByLabelText("Widget Browser Source URL").every(node => !node.textContent?.includes("overlay-token"))).toBe(true);
    screen.getAllByRole("button", { name: "Reveal" }).forEach(button => fireEvent.click(button));
    const urls = screen
      .getAllByLabelText("Widget Browser Source URL")
      .map((node) => node.textContent);
    for (const background of STREAM_BACKGROUNDS) {
      expect(screen.getByRole("button", { name: background.label })).toBeTruthy();
      expect(urls).toContain(
        `https://studio.example/overlay/overlay-token/scene/${background.id}`,
      );
    }
  });

  it("loads a clean named set in the shared preview", () => {
    const background = STREAM_BACKGROUNDS[5];
    render(
      <OverlayScenesSection
        token="overlay-token"
        origin="https://studio.example"
        theme={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: background.label }));
    expect(screen.getByTitle("Scene preview").getAttribute("src")).toBe(
      `https://studio.example/overlay/overlay-token/scene/${background.id}`,
    );
    expect(screen.getByText(/clean virtual set/i)).toBeTruthy();
  });
});

describe("OverlayScenesSection credit flag", () => {
  it("keeps Browser Source URLs stable and applies the saved credit to the demo", () => {
    const scenes = (credit: boolean) => <OverlayFlagsContext.Provider value={{ ...DEFAULT_OVERLAY_FLAGS, credit }}>
      <OverlayScenesSection token="overlay-token" origin="https://studio.example" theme={{}} />
    </OverlayFlagsContext.Provider>;
    const { rerender } = render(scenes(true));
    screen.getAllByRole("button", { name: "Reveal" }).forEach(button => fireEvent.click(button));
    const urls = () => screen.getAllByLabelText("Widget Browser Source URL").map((node) => node.textContent);
    const live = "https://studio.example/overlay/overlay-token/scene/starting-soon";
    expect(urls()).toContain(live);
    const startingSoon = screen.getByRole("button", { name: /starting soon/i });
    fireEvent.click(startingSoon);
    expect(screen.getByTitle("Scene preview").getAttribute("src")).toBe(`${live}?demo=1`);

    rerender(scenes(false));
    expect(urls()).toContain(live);
    expect(urls()).not.toContain(`${live}?credit=0`);
    expect(screen.getByTitle("Scene preview").getAttribute("src")).toBe(`${live}?demo=1&credit=0`);
    expect(urls()).toContain(`https://studio.example/overlay/overlay-token/scene/${STREAM_BACKGROUNDS[0].id}`);
  });

  it("previews a saved QR only on eligible scenes without changing copied source URLs", () => {
    const setCreditQr = vi.fn();
    const scenes = (credit: boolean, creditQr = false) => <OverlayFlagsContext.Provider value={{ ...DEFAULT_OVERLAY_FLAGS, credit, creditQr, setCreditQr }}>
      <OverlayScenesSection token="overlay-token" origin="https://studio.example" theme={{}} />
    </OverlayFlagsContext.Provider>;
    const { rerender } = render(scenes(true));
    const toggle = screen.getByRole("switch", { name: "Show a QR code on Starting Soon and BRB" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(setCreditQr).toHaveBeenCalledWith(true);
    rerender(scenes(true, true));
    const preview = () => screen.getByTitle("Scene preview").getAttribute("src");
    expect(preview()).toContain("/scene/between-games?demo=1");
    expect(preview()).not.toContain("creditQr");
    fireEvent.click(screen.getByRole("button", { name: "Be Right Back" }));
    expect(preview()).toBe("https://studio.example/overlay/overlay-token/scene/brb?demo=1&creditQr=1");
    screen.getAllByRole("button", { name: "Reveal" }).forEach(button => fireEvent.click(button));
    const urls = screen.getAllByLabelText("Widget Browser Source URL").map(node => node.textContent);
    expect(urls).toContain("https://studio.example/overlay/overlay-token/scene/brb");
    expect(urls.every(url => !url?.includes("creditQr"))).toBe(true);
    rerender(scenes(false, true));
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(preview()).toBe("https://studio.example/overlay/overlay-token/scene/brb?demo=1&credit=0");
  });
});
