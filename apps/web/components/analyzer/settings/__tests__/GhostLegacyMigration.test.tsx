import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GhostLegacyMigration } from "../GhostLegacyMigration";
import {
  GHOST_BUILD_VERSION,
  GHOST_MATCHUPS,
  type GhostTarget,
} from "@/lib/ghostBuild";

afterEach(cleanup);

const TARGET: GhostTarget = {
  v: GHOST_BUILD_VERSION,
  name: "Legacy two-base pressure",
  steps: [
    { supply: 14, t: 18, name: "Pylon" },
    { supply: 16, t: 42, name: "Gateway" },
    { supply: 22, t: 155, name: "Stargate" },
  ],
};

describe("GhostLegacyMigration", () => {
  it("shows the previous build and all nine explicit matchup choices", () => {
    render(<GhostLegacyMigration target={TARGET} onMigrate={vi.fn()} />);

    expect(screen.getByText("Upgrade your previous Ghost build")).toBeTruthy();
    expect(screen.getByText(TARGET.name)).toBeTruthy();
    expect(screen.getByText("3 timed steps")).toBeTruthy();
    expect(screen.getByText("through 2:35")).toBeTruthy();
    expect(screen.getByText(/will not guess or copy it/i)).toBeTruthy();

    const choices = screen.getAllByRole("option");
    expect(choices).toHaveLength(10);
    expect(choices.slice(1).map((option) => option.getAttribute("value"))).toEqual(
      expect.arrayContaining([...GHOST_MATCHUPS]),
    );
  });

  it("requires one exact selection and emits only that matchup", () => {
    const onMigrate = vi.fn();
    render(<GhostLegacyMigration target={TARGET} onMigrate={onMigrate} />);

    const button = screen.getByRole("button", { name: "Choose a matchup" });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Assign to one matchup"), {
      target: { value: "ZvT" },
    });
    const ready = screen.getByRole("button", { name: "Upgrade to ZvT" });
    expect((ready as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(ready);

    expect(onMigrate).toHaveBeenCalledTimes(1);
    expect(onMigrate).toHaveBeenCalledWith("ZvT");
  });

  it("is bounded and stacks its action on narrow screens", () => {
    render(
      <GhostLegacyMigration
        target={TARGET}
        onMigrate={vi.fn()}
        disabled
      />,
    );

    const region = screen.getByTestId("ghost-legacy-migration");
    expect(region.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["min-w-0", "max-w-full"]),
    );
    const select = screen.getByLabelText("Assign to one matchup");
    expect((select as HTMLSelectElement).disabled).toBe(true);
    const button = screen.getByRole("button", { name: "Choose a matchup" });
    expect(button.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["w-full", "sm:w-auto"]),
    );
  });
});
