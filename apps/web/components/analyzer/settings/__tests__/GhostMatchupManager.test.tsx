import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { GhostMatchupManager } from "../GhostMatchupManager";
import {
  GHOST_BUILD_VERSION,
  type GhostBuildConfig,
  type GhostMatchupKey,
  type GhostTarget,
  type SavedGhostBuild,
} from "@/lib/ghostBuild";

afterEach(cleanup);

function target(name: string, finalTime = 150, stepCount = 3): GhostTarget {
  return {
    v: GHOST_BUILD_VERSION,
    name,
    steps: Array.from({ length: stepCount }, (_, index) => ({
      supply: 14 + index * 2,
      t: index === stepCount - 1 ? finalTime : 20 + index * 35,
      name: `Step${index + 1}`,
    })),
  };
}

function saved(
  id: string,
  matchup: GhostMatchupKey,
  build: GhostTarget,
): SavedGhostBuild {
  return {
    id,
    matchup,
    target: build,
    savedAt: "2026-07-12T12:00:00.000Z",
  };
}

function config(
  slots: GhostBuildConfig["slots"] = {},
): GhostBuildConfig {
  return { v: 2, slots };
}

describe("GhostMatchupManager", () => {
  it("renders nine responsive slots grouped by the player's race", () => {
    render(
      <GhostMatchupManager
        loadout={config()}
        library={[]}
        onAssign={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByText("When you play Terran")).toBeTruthy();
    expect(screen.getByText("When you play Protoss")).toBeTruthy();
    expect(screen.getByText("When you play Zerg")).toBeTruthy();
    expect(screen.getAllByTestId(/^ghost-matchup-slot-/)).toHaveLength(9);
    for (const matchup of [
      "TvT", "TvP", "TvZ", "PvT", "PvP", "PvZ", "ZvT", "ZvP", "ZvZ",
    ]) {
      expect(screen.getByTestId(`ghost-matchup-slot-${matchup}`)).toBeTruthy();
    }

    const manager = screen.getByTestId("ghost-matchup-manager");
    expect(manager.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["min-w-0", "max-w-full"]),
    );
    for (const group of ["terran", "protoss", "zerg"]) {
      const fieldset = screen.getByTestId(`ghost-race-group-${group}`);
      expect(fieldset.className.split(/\s+/)).toContain("min-w-0");
      const grid = fieldset.querySelector(".grid");
      expect(grid?.className.split(/\s+/)).toEqual(
        expect.arrayContaining([
          "min-w-0",
          "grid-cols-1",
          "md:grid-cols-2",
          "lg:grid-cols-3",
        ]),
      );
    }
    for (const slot of screen.getAllByTestId(/^ghost-matchup-slot-/)) {
      expect(slot.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["min-w-0", "max-w-full"]),
      );
    }
  });

  it("explains the empty library, every empty slot, and the Random safety rule", () => {
    render(
      <GhostMatchupManager
        loadout={config()}
        library={[]}
        onAssign={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByText("No timed builds saved yet")).toBeTruthy();
    expect(
      screen.getByText(/Open a completed game, review your build order/i),
    ).toBeTruthy();
    expect(screen.getAllByText("No coach assigned")).toHaveLength(9);
    expect(screen.getByText(/Random opponents are disabled/i)).toBeTruthy();
    expect(screen.getByText(/No build order vs Random players/i)).toBeTruthy();
    expect(screen.getByText("0 / 9 ready")).toBeTruthy();

    const pvt = screen.getByLabelText("Select build for PvT") as HTMLSelectElement;
    expect(pvt.disabled).toBe(true);
    expect(screen.getByText("No saved PvT builds available yet.")).toBeTruthy();
    const describedBy = pvt.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toBeTruthy();
  });

  it("filters choices by matchup and assigns a replacement accessibly", () => {
    const current = target("PvT Safe Raven timing", 150, 3);
    const replacement = saved(
      "pvt-replacement",
      "PvT",
      target("PvT Two-base pressure", 245, 5),
    );
    const otherMatchup = saved(
      "pvz-wrong-slot",
      "PvZ",
      target("PvZ Stargate", 190, 4),
    );
    const onAssign = vi.fn();

    render(
      <GhostMatchupManager
        loadout={config({ PvT: current })}
        library={[
          saved("pvt-current", "PvT", current),
          replacement,
          otherMatchup,
        ]}
        onAssign={onAssign}
        onClear={vi.fn()}
      />,
    );

    const pvtSlot = screen.getByTestId("ghost-matchup-slot-PvT");
    expect(
      pvtSlot.querySelector('p[title="PvT Safe Raven timing"]'),
    ).toBeTruthy();
    expect(within(pvtSlot).getByText("3 timed steps")).toBeTruthy();
    expect(within(pvtSlot).getByText("through 2:30")).toBeTruthy();
    expect(screen.getByText("1 / 9 ready")).toBeTruthy();

    const select = within(pvtSlot).getByLabelText(
      "Replace build for PvT",
    ) as HTMLSelectElement;
    expect(select.value).toBe("saved:pvt-current");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "PvT Safe Raven timing",
      "PvT Two-base pressure",
    ]);
    expect(Array.from(select.options).map((option) => option.textContent)).not.toContain(
      "PvZ Stargate",
    );

    fireEvent.change(select, { target: { value: "saved:pvt-replacement" } });
    expect(onAssign).toHaveBeenCalledTimes(1);
    expect(onAssign).toHaveBeenCalledWith("PvT", replacement);
  });

  it("assigns an empty slot and clears a configured slot without deleting its saved build", () => {
    const pvt = saved("pvt", "PvT", target("PvT Mine drop", 210, 4));
    const pvzTarget = target("PvZ Oracle", 180, 4);
    const pvz = saved("pvz", "PvZ", pvzTarget);
    const onAssign = vi.fn();
    const onClear = vi.fn();

    render(
      <GhostMatchupManager
        loadout={config({ PvZ: pvzTarget })}
        library={[pvt, pvz]}
        onAssign={onAssign}
        onClear={onClear}
      />,
    );

    const pvtSelect = screen.getByLabelText("Select build for PvT");
    fireEvent.change(pvtSelect, { target: { value: "saved:pvt" } });
    expect(onAssign).toHaveBeenCalledWith("PvT", pvt);

    fireEvent.click(screen.getByRole("button", { name: "Clear PvZ build" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledWith("PvZ");
    // Clearing a slot is deliberately a separate callback from library removal.
    expect(within(screen.getByTestId("ghost-matchup-slot-PvZ")).getByRole("option", {
      name: "PvZ Oracle",
    })).toBeTruthy();
  });

  it("locks selection and clear actions while the parent is saving", () => {
    const build = saved("tvt", "TvT", target("TvT Reaper expand"));
    render(
      <GhostMatchupManager
        loadout={config({ TvT: build.target })}
        library={[build]}
        onAssign={vi.fn()}
        onClear={vi.fn()}
        disabled
      />,
    );

    for (const select of screen.getAllByRole("combobox")) {
      expect((select as HTMLSelectElement).disabled).toBe(true);
    }
    for (const fieldset of screen.getAllByRole("group")) {
      expect((fieldset as HTMLFieldSetElement).disabled).toBe(true);
    }
    expect(
      (screen.getByRole("button", { name: "Clear TvT build" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
