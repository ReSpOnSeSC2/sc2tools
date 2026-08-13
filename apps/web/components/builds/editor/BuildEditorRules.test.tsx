import { cleanup, render, screen } from "@testing-library/react";
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
});
