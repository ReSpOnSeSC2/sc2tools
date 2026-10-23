import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefinitionsCatalog, DefinitionsHeaderHint } from "./DefinitionsCatalog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The card for a definition id. */
function card(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no card #${id}`);
  return el;
}

describe("DefinitionsCatalog", () => {
  it("lists the labels the engine catalog used to lack", () => {
    render(<DefinitionsCatalog />);
    expect(within(card("zerg-hatch-first")).getByText("Zerg - Hatch First")).toBeTruthy();
    expect(within(card("tvp-1-1-1-one-base")).getByText("TvP - 1-1-1 One Base")).toBeTruthy();
  });

  it("gives every card an anchor and a copy-link button", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<DefinitionsCatalog />);
    const glaives = card("pvz-stargate-into-glaives");
    expect(glaives.className).toContain("scroll-mt-24");
    fireEvent.click(within(glaives).getByRole("button", { name: "Copy link to PvZ - Stargate into Glaives" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/definitions#pvz-stargate-into-glaives`);
    expect(
      await within(glaives).findByRole("button", { name: "Link to PvZ - Stargate into Glaives copied" }),
    ).toBeTruthy();
  });

  it("links published guides, one per matchup, and none when there are none", () => {
    render(
      <DefinitionsCatalog
        guideLinks={{
          "pvz-stargate-into-glaives": [{ matchup: "PvZ", href: "/guides/pvz/stargate-into-glaives" }],
          "zerg-12-pool": [
            { matchup: "ZvP", href: "/guides/zvp/12-pool" },
            { matchup: "ZvT", href: "/guides/zvt/12-pool" },
          ],
        }}
      />,
    );
    const single = within(card("pvz-stargate-into-glaives")).getByRole("link", {
      name: "PvZ guide for PvZ - Stargate into Glaives",
    });
    expect(single.textContent).toBe("Guide");
    expect(single.getAttribute("href")).toBe("/guides/pvz/stargate-into-glaives");
    const pool = within(card("zerg-12-pool")).getAllByRole("link");
    expect(pool.map((link) => link.textContent)).toEqual(["ZvP guide", "ZvT guide"]);
    expect(within(card("pvz-robo-opener")).queryByRole("link")).toBeNull();
  });

  it("shows the 8-worker patch name and finds the label by it", () => {
    render(<DefinitionsCatalog />);
    expect(within(card("zerg-12-pool")).getByText("Zerg - 8 Pool")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search builds and strategies"), {
      target: { value: "8 pool" },
    });
    expect(document.getElementById("zerg-12-pool")).toBeTruthy();
    expect(document.getElementById("pvz-robo-opener")).toBeNull();
  });

  it("links the header to the detected vs custom builds article", () => {
    render(<DefinitionsHeaderHint />);
    const link = screen.getByRole("link", { name: "Detected builds vs custom builds" });
    expect(link.getAttribute("href")).toBe("/help/custom-builds");
  });
});
