/**
 * SectionHeader: each analyzer section's name, intro and "How to read
 * this" link, with an intro the reader can hide (remembered per section
 * on this device) and bring back from the help link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { introHiddenKey, SectionHeader } from "../SectionHeader";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));

const MAPS_INTRO = "Maps and matchup performance.";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

/**
 * The help link, once its lazy chunk has turned it into the
 * sheet-opening HelpLink (the first load imports every article).
 */
async function helpLink(): Promise<HTMLElement> {
  await waitFor(
    () => expect(screen.getByRole("link", { name: "How to read this" }).getAttribute("aria-haspopup")).toBe("dialog"),
    { timeout: 5000 },
  );
  return screen.getByRole("link", { name: "How to read this" });
}

describe("SectionHeader", () => {
  it("names the section in an h2 under the context bar's h1, with its intro and help link", async () => {
    render(<SectionHeader tab="battlefield" />);
    expect(screen.getByRole("heading", { level: 2, name: "Maps" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByText(MAPS_INTRO)).toBeTruthy();
    // The help slug is the section's URL segment: battlefield lives at /app/maps.
    expect((await helpLink()).getAttribute("href")).toBe("/help/maps");
  });

  it("hides the intro, remembers it for that section and moves focus to the help link", async () => {
    render(<SectionHeader tab="battlefield" />);
    const link = await helpLink();
    fireEvent.click(screen.getByRole("button", { name: "Hide intro" }));
    expect(screen.queryByText(MAPS_INTRO)).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide intro" })).toBeNull();
    expect(document.activeElement).toBe(link);
    await waitFor(() => expect(window.localStorage.getItem(introHiddenKey("battlefield"))).toBe("true"));
    expect(window.localStorage.getItem(introHiddenKey("strategies"))).toBeNull();
  });

  it("keeps a hidden intro hidden on the next visit, and How to read this brings it back", async () => {
    window.localStorage.setItem(introHiddenKey("strategies"), "true");
    render(<SectionHeader tab="strategies" />);
    await waitFor(() => expect(screen.queryByText("Build vs strategy and per-strategy results.")).toBeNull());
    fireEvent.click(await helpLink());
    expect(screen.getByText("Build vs strategy and per-strategy results.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Strategies: your builds against their openings" })).toBeTruthy();
    await waitFor(() => expect(window.localStorage.getItem(introHiddenKey("strategies"))).toBe("false"));
  });

  it("takes a custom title, intro and actions", async () => {
    render(
      <SectionHeader
        tab="opponents"
        title="Everyone you've faced"
        description="Keyed to their SC2Pulse ID."
        actions={<span>12 players</span>}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Everyone you've faced" })).toBeTruthy();
    expect(screen.getByText("Keyed to their SC2Pulse ID.")).toBeTruthy();
    expect(screen.getByText("12 players")).toBeTruthy();
    expect((await helpLink()).getAttribute("href")).toBe("/help/opponents");
  });
});
