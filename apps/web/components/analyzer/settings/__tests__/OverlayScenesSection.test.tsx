import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { setOverlayCreditPreference } from "@/lib/overlayCredit";
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
  it("bakes credit=0 into the animated scenes once the credit is switched off", () => {
    render(<OverlayScenesSection token="overlay-token" origin="https://studio.example" theme={{}} />);
    const urls = () => screen.getAllByLabelText("Widget Browser Source URL").map((node) => node.textContent);
    expect(urls()).toContain("https://studio.example/overlay/overlay-token/scene/starting-soon");

    act(() => setOverlayCreditPreference(false));
    expect(urls()).toContain("https://studio.example/overlay/overlay-token/scene/starting-soon?credit=0");
    // Virtual sets never show the credit, so their URLs never change.
    expect(urls()).toContain(`https://studio.example/overlay/overlay-token/scene/${STREAM_BACKGROUNDS[0].id}`);
  });
});
