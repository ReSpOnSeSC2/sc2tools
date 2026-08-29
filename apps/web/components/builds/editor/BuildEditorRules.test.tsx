import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuildEditorRules } from "./BuildEditorRules";
import type { BuildEditorDraft } from "@/lib/build-rules";

afterEach(cleanup);

describe("BuildEditorRules wording", () => {
  it("explains the not-before rule consistently without showing NOT by", () => {
    const draft: BuildEditorDraft = {
      name: "PvT test",
      description: "",
      race: "Protoss",
      vsRace: "Terran",
      skillLevel: null,
      shareWithCommunity: false,
      winConditions: [],
      losesTo: [],
      transitionsInto: [],
      rules: [
        {
          type: "not_before",
          name: "BuildRoboticsFacility",
          time_lt: 240,
        },
      ],
    };

    render(
      <BuildEditorRules
        draft={draft}
        errors={{}}
        sourceRows={[]}
        updateRule={vi.fn()}
        removeRule={vi.fn()}
        cycleRule={vi.fn()}
        addRuleFromEvent={vi.fn()}
        addCustomRule={vi.fn()}
      />,
    );

    expect(screen.queryByText(/NOT by/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: "✗ Not built before" }),
    ).toBeTruthy();
    expect(screen.getByText("must not be built before")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Change rule type. Current rule: Must not be built before",
      }),
    ).toBeTruthy();
    expect(screen.getByTitle(/Earliest allowed time/)).toBeTruthy();
  });

  it("shows proxy evidence and exposes an editable proxy-only requirement", () => {
    const updateRule = vi.fn();
    const addRuleFromEvent = vi.fn();
    const draft: BuildEditorDraft = {
      name: "Proxy test",
      description: "",
      race: "Terran",
      vsRace: "Protoss",
      skillLevel: null,
      shareWithCommunity: false,
      winConditions: [],
      losesTo: [],
      transitionsInto: [],
      rules: [{
        type: "before",
        name: "BuildBarracks",
        time_lt: 120,
        proxy: true,
      }, {
        type: "not_before",
        name: "BuildMarine",
        time_lt: 120,
      }],
    };
    render(
      <BuildEditorRules
        draft={draft}
        errors={{}}
        sourceRows={[{
          key: "proxy-factory",
          t: 90,
          what: "BuildFactory",
          display: "Factory",
          timeDisplay: "1:30",
          race: "Terran",
          category: "building",
          isBuilding: true,
          isProxy: true,
          isTech: false,
        }]}
        updateRule={updateRule}
        removeRule={vi.fn()}
        cycleRule={vi.fn()}
        addRuleFromEvent={addRuleFromEvent}
        addCustomRule={vi.fn()}
      />,
    );

    expect(screen.getByText("Proxy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {
      name: "Add BuildFactory as a rule",
    }));
    expect(addRuleFromEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "BuildFactory",
      is_proxy: true,
    }));

    const checkbox = screen.getByRole("checkbox", {
      name: "Require BuildBarracks to be proxied",
    });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(checkbox);
    expect(updateRule).toHaveBeenCalledWith(0, { proxy: false });
    fireEvent.change(screen.getAllByTitle(
      "Event token (e.g. BuildStargate, ResearchBlink)",
    )[0], { target: { value: "BuildMarine" } });
    expect(updateRule).toHaveBeenCalledWith(0, {
      name: "BuildMarine",
      proxy: false,
    });
    expect((screen.getByRole("checkbox", {
      name: "Require BuildMarine to be proxied",
    }) as HTMLInputElement).disabled).toBe(true);
  });
});
