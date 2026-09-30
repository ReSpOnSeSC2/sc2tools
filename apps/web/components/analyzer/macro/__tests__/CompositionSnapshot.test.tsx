/**
 * The roster's tap-to-enlarge affordance.
 *
 * The chips are 22 px 3D renders whose only label was a ``title``
 * tooltip — which touch devices never show, so on a phone the roster
 * was a row of unidentifiable thumbnails. Every chip is now a button
 * that opens a dialog naming what it is.
 *
 * These tests pin: the chips are buttons with an accessible name,
 * activating one names the thing, the dialog reports a tiered upgrade
 * as a LEVEL rather than a quantity (``countUpgradesAt`` reuses the
 * count slot to carry the tier), and Escape closes it.
 *
 * Plain vitest assertions only: this repo has no jest-dom.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CompositionSnapshot } from "../CompositionSnapshot";
import type { SeriesPoint } from "../activeArmyLayout";

afterEach(cleanup);

function point(units: Record<string, number>): SeriesPoint {
  return {
    t: 600,
    army: 2400,
    workers: 42,
    armySource: "stats",
    units,
    unitsSource: "timeline",
  };
}

const BUILD_ORDER = {
  ok: true,
  events: [
    { time: 20, name: "Nexus", is_building: true, category: "building" },
    { time: 120, name: "Gateway", is_building: true, category: "building" },
    {
      time: 300,
      complete_time: 400,
      name: "ProtossGroundWeaponsLevel3",
      category: "upgrade",
    },
    { time: 320, complete_time: 420, name: "Charge", category: "upgrade" },
  ],
  opp_events: [],
};

function renderSnapshot() {
  return render(
    <CompositionSnapshot
      mySeries={[point({ Stalker: 12, Zealot: 4 })]}
      oppSeries={[point({ Marine: 20 })]}
      hoveredTime={600}
      gameLengthSec={900}
      myName="Jonathan"
      oppName="Rival"
      myRace="Protoss"
      oppRace="Terran"
      buildOrderData={BUILD_ORDER}
    />,
  );
}

describe("CompositionSnapshot chips", () => {
  it("names every chip in its accessible name, not just a tooltip", () => {
    renderSnapshot();
    // 12 Stalkers on the field — the count is spelled out, so a screen
    // reader and a touch user get what only a hover used to give.
    expect(
      screen.getByRole("button", { name: "Stalker — 12 on the field" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Nexus — 1 on the field" }),
    ).toBeTruthy();
    // PascalCase is spaced out for humans.
    expect(
      screen.getByRole("button", { name: "Probe — 42 on the field" }),
    ).toBeTruthy();
  });

  it("reports a tiered upgrade as a level, not as a quantity", () => {
    renderSnapshot();
    // countUpgradesAt collapses +1/+2/+3 into one chip whose "count" IS
    // the tier. Captioning that as "3 ×" would be a lie.
    const chip = screen.getByRole("button", {
      name: "Protoss Ground Weapons — Level 3",
    });
    expect(chip.textContent).toContain("3");
  });

  it("shows no number on a one-off research, which has no level", () => {
    renderSnapshot();
    const chip = screen.getByRole("button", { name: "Charge — Researched" });
    expect(chip.textContent).not.toMatch(/\d/);
  });

  it("opens a dialog naming the unit, with its cost", () => {
    renderSnapshot();
    fireEvent.click(
      screen.getByRole("button", { name: "Stalker — 12 on the field" }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Stalker");
    expect(dialog.textContent).toContain("12 on the field");
    // Cost each, then the group total: 12 × (125 m / 50 g / 2 supply).
    expect(dialog.textContent).toContain("125 minerals · 50 gas · 2 supply");
    expect(dialog.textContent).toContain("1,500 minerals · 600 gas · 24 supply");
    // Whose roster, and at what point on the chart.
    expect(dialog.textContent).toContain("Jonathan");
    expect(dialog.textContent).toContain("10:00");
  });

  it("labels a structure as a structure and skips the total for one of them", () => {
    renderSnapshot();
    fireEvent.click(
      screen.getByRole("button", { name: "Nexus — 1 on the field" }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Nexus");
    expect(dialog.textContent).toContain("Structure");
    expect(dialog.textContent).toContain("400 minerals");
    expect(dialog.textContent).not.toContain("Total");
  });

  it("closes on Escape and hands focus back to the chip", () => {
    renderSnapshot();
    const chip = screen.getByRole("button", { name: "Zealot — 4 on the field" });
    // jsdom's click does not move focus the way a real pointer does, so
    // focus the chip first — otherwise the dialog would have nothing to
    // hand focus back to and the restore would silently look correct.
    chip.focus();
    fireEvent.click(chip);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("warns in the dialog when the counts came from the build order", () => {
    // No production_buildings payload, so the Buildings row falls back
    // to the cumulative build-order count and cannot subtract losses.
    // The row's badge says so on hover; the dialog has to say it too,
    // because hover does not exist on the device this dialog is for.
    renderSnapshot();
    fireEvent.click(
      screen.getByRole("button", { name: "Gateway — 1 on the field" }),
    );
    expect(screen.getByRole("dialog").textContent).toContain(
      "per-tick deaths aren't tracked",
    );
  });
});

describe("CompositionSnapshot costs by patch era", () => {
  function openQueen(patchEra?: "after" | "before") {
    render(
      <CompositionSnapshot
        mySeries={[point({ Queen: 3 })]}
        oppSeries={[point({ Marine: 20 })]}
        hoveredTime={600}
        gameLengthSec={900}
        myRace="Zerg"
        oppRace="Terran"
        buildOrderData={BUILD_ORDER}
        patchEra={patchEra}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Queen — 3 on the field" }));
    return screen.getByRole("dialog").textContent;
  }

  it("prices a 12-worker game at the LotV base balance", () => {
    const text = openQueen("after");
    expect(text).toContain("175 minerals · 2 supply");
    expect(text).toContain("525 minerals · 6 supply");
  });

  it("prices an 8-worker 5.0.16 game at 5.0.16b", () => {
    const text = openQueen("before");
    expect(text).toContain("150 minerals · 2 supply");
    expect(text).toContain("450 minerals · 6 supply");
  });

  it("defaults to the live 12-worker balance", () => {
    expect(openQueen()).toContain("175 minerals · 2 supply");
  });
});

describe("CompositionSnapshot chip art", () => {
  it("draws a Broodling with the Brood Lord's 3D model, not a text badge", () => {
    render(
      <CompositionSnapshot
        mySeries={[point({ Broodling: 6 })]}
        oppSeries={[point({ Marine: 20 })]}
        hoveredTime={600}
        gameLengthSec={900}
        myName="Jonathan"
        oppName="Rival"
        myRace="Zerg"
        oppRace="Terran"
        buildOrderData={BUILD_ORDER}
      />,
    );
    const chip = screen.getByRole("button", { name: "Broodling — 6 on the field" });
    const img = chip.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/sprites/icons/BroodLord_blue.webp");
  });
});

