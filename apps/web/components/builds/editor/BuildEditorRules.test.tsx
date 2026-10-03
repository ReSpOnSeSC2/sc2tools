import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuildEditorRules } from "./BuildEditorRules";
import type { BuildEditorRulesProps } from "./BuildEditor.types";
import {
  defaultRuleFor,
  type BuildEditorDraft,
  type BuildRule,
  type SourceTimelineRow,
} from "@/lib/build-rules";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeDraft(
  rules: BuildRule[],
  overrides: Partial<BuildEditorDraft> = {},
): BuildEditorDraft {
  return {
    name: "PvT test",
    description: "",
    race: "Protoss",
    vsRace: "Terran",
    skillLevel: null,
    shareWithCommunity: false,
    winConditions: [],
    losesTo: [],
    transitionsInto: [],
    rules,
    ...overrides,
  };
}

function renderRules(props: Partial<BuildEditorRulesProps> & { draft: BuildEditorDraft }) {
  const all: BuildEditorRulesProps = {
    errors: {},
    sourceRows: [],
    updateRule: vi.fn(),
    removeRule: vi.fn(),
    setRuleQuantity: vi.fn(),
    setRuleCount: vi.fn(),
    addRuleFromEvent: vi.fn(),
    addCustomRule: vi.fn(),
    ...props,
  };
  return { ...render(<BuildEditorRules {...all} />), props: all };
}

const stargate = (t: number): SourceTimelineRow => ({
  key: `t${t}:BuildStargate`,
  t,
  what: "BuildStargate",
  display: "Stargate",
  timeDisplay: `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`,
  race: "Protoss",
  category: "building",
  isBuilding: true,
  isProxy: false,
  isTech: true,
});

const liveRegion = () =>
  document.querySelector('[role="status"][aria-live="polite"]');

describe("BuildEditorRules wording", () => {
  it("offers a discoverable proxy-building rule before any rules exist", () => {
    const addCustomRule = vi.fn();
    renderRules({ draft: makeDraft([], { name: "Proxy opener" }), addCustomRule });

    fireEvent.click(screen.getByRole("button", { name: "Proxy building" }));
    expect(addCustomRule).toHaveBeenCalledWith("before", {
      proxyOnly: true,
    });
  });

  it("explains the not-before rule consistently without showing NOT by", () => {
    renderRules({
      draft: makeDraft([
        { type: "not_before", name: "BuildRoboticsFacility", time_lt: 240 },
      ]),
    });

    expect(screen.queryByText(/NOT by/i)).toBeNull();
    expect(screen.getByRole("button", { name: "None before" })).toBeTruthy();
    expect(
      (screen.getByRole("combobox", { name: "How many" }) as HTMLSelectElement).value,
    ).toBe("none");
    expect(screen.getByRole("group", {
      name: /no Robotics Facility starts before 4:00/,
    })).toBeTruthy();
    expect(screen.getByTitle(/Fails if one starts before this game time/)).toBeTruthy();
  });

  it("shows proxy evidence and exposes an editable proxy-only requirement", () => {
    const updateRule = vi.fn();
    const addRuleFromEvent = vi.fn();
    renderRules({
      draft: makeDraft([
        { type: "before", name: "BuildBarracks", time_lt: 120, proxy: true },
        { type: "not_before", name: "BuildMarine", time_lt: 120 },
      ], { race: "Terran", vsRace: "Protoss" }),
      sourceRows: [{
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
      }],
      updateRule,
      addRuleFromEvent,
    });

    expect(screen.getByText("Proxy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {
      name: "Add rule: at least 1 proxied Factory before 2:00",
    }));
    expect(addRuleFromEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "BuildFactory",
      is_proxy: true,
    }));

    const checkbox = screen.getByRole("checkbox", {
      name: "Only count proxied Barracks",
    });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(checkbox);
    expect(updateRule).toHaveBeenCalledWith(0, { proxy: false });
    const ruleName = screen.getAllByTitle(
      "Event token (e.g. BuildStargate, ResearchBlink)",
    )[0];
    ruleName.focus();
    fireEvent.change(ruleName, { target: { value: "BuildMarine" } });
    expect(updateRule).toHaveBeenCalledWith(0, {
      name: "BuildMarine",
    });
    expect(document.activeElement).toBe(ruleName);
    // Units no longer carry a permanently disabled proxy box.
    expect(screen.queryByRole("checkbox", { name: /Marine/ })).toBeNull();
  });

  it("keeps focus and proxy intent while an eligible building token is typed", () => {
    function StatefulRules() {
      const [draft, setDraft] = useState<BuildEditorDraft>(makeDraft(
        [{ type: "before", name: "", time_lt: 60, proxy: true }],
        { name: "Proxy test", race: "Terran", vsRace: "Protoss" },
      ));
      return (
        <BuildEditorRules
          draft={draft}
          errors={{}}
          sourceRows={[]}
          updateRule={(idx, patch) => setDraft((current) => ({
            ...current,
            rules: current.rules.map((rule, ruleIdx) =>
              ruleIdx === idx ? { ...rule, ...patch } as typeof rule : rule,
            ),
          }))}
          removeRule={vi.fn()}
          setRuleQuantity={vi.fn()}
          setRuleCount={vi.fn()}
          addRuleFromEvent={vi.fn()}
          addCustomRule={vi.fn()}
        />
      );
    }

    render(<StatefulRules />);
    const input = screen.getByTitle(
      "Event token (e.g. BuildStargate, ResearchBlink)",
    ) as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "B" } });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "BuildBarracks" } });
    expect(document.activeElement).toBe(input);
    expect((screen.getByRole("checkbox", {
      name: "Only count proxied Barracks",
    }) as HTMLInputElement).checked).toBe(true);
  });

  it("add bar buttons call addCustomRule with before / count_exact / count_max / not_before", () => {
    const addCustomRule = vi.fn();
    renderRules({ draft: makeDraft([]), addCustomRule });
    const bar = screen.getByRole("group", { name: "Add a rule:" });

    for (const name of ["At least", "Exactly", "At most", "None before"]) {
      fireEvent.click(within(bar).getByRole("button", { name }));
    }
    expect(addCustomRule.mock.calls).toEqual([
      ["before"],
      ["count_exact"],
      ["count_max"],
      ["not_before"],
    ]);
  });

  it("disables the add bar at the 30-rule limit", () => {
    const rules = Array.from({ length: 30 }, (_, i) => defaultRuleFor(
      "before", `BuildFiller${i}`, 60,
    ));
    renderRules({ draft: makeDraft(rules) });
    const bar = screen.getByRole("group", { name: "Add a rule:" });

    for (const button of within(bar).getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(within(bar).getByText("30-rule limit reached.")).toBeTruthy();
  });

  it("focuses the new rule's token input and announces the add", () => {
    function StatefulRules() {
      const [draft, setDraft] = useState(makeDraft([]));
      return (
        <BuildEditorRules
          draft={draft}
          errors={{}}
          sourceRows={[]}
          updateRule={vi.fn()}
          removeRule={vi.fn()}
          setRuleQuantity={vi.fn()}
          setRuleCount={vi.fn()}
          addRuleFromEvent={vi.fn()}
          addCustomRule={(type) => setDraft((d) => ({
            ...d,
            rules: [...d.rules, defaultRuleFor(type, "", 60)],
          }))}
        />
      );
    }
    render(<StatefulRules />);

    fireEvent.click(screen.getByRole("button", { name: "Exactly" }));
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Unit, building or upgrade" }),
    );
    expect(liveRegion()?.textContent).toBe(
      "Added a blank “Exactly” rule. Enter a unit, building or upgrade.",
    );
  });

  it("announces picker changes, removals and timeline adds once, then clears", () => {
    vi.useFakeTimers();
    const setRuleQuantity = vi.fn();
    const removeRule = vi.fn();
    renderRules({
      draft: makeDraft([
        { type: "before", name: "BuildVoidRay", time_lt: 400 },
        { type: "not_before", name: "BuildRoboticsFacility", time_lt: 240 },
      ]),
      sourceRows: [stargate(170)],
      setRuleQuantity,
      removeRule,
    });

    const [firstPicker] = screen.getAllByRole("combobox", { name: "How many" });
    fireEvent.change(firstPicker, { target: { value: "exactly" } });
    expect(setRuleQuantity).toHaveBeenCalledWith(0, "exactly", 1);
    expect(liveRegion()?.textContent).toBe(
      "Rule 1 now: exactly 1 Void Ray before 6:40.",
    );

    fireEvent.click(screen.getByRole("button", {
      name: "Remove rule 2: no Robotics Facility before 4:00",
    }));
    expect(removeRule).toHaveBeenCalledWith(1);
    expect(liveRegion()?.textContent).toBe(
      "Removed rule 2: no Robotics Facility before 4:00.",
    );

    fireEvent.click(screen.getByRole("button", {
      name: "Add rule: at least 1 Stargate before 3:20",
    }));
    expect(liveRegion()?.textContent).toBe(
      "Added: at least 1 Stargate before 3:20.",
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(liveRegion()?.textContent).toBe("");
  });

  it("warns when every rule only caps or forbids", () => {
    const capOnly = [
      { type: "not_before", name: "BuildRoboticsFacility", time_lt: 240 },
      { type: "count_max", name: "BuildStargate", count: 1, time_lt: 360 },
      { type: "count_exact", name: "BuildForge", count: 0, time_lt: 300 },
      { type: "before", name: "", time_lt: 60 },
    ] satisfies BuildRule[];
    const { rerender, props } = renderRules({ draft: makeDraft(capOnly) });
    const warning = /Every rule here also passes when none of it is built/;
    expect(screen.getByText(warning)).toBeTruthy();

    rerender(
      <BuildEditorRules
        {...props}
        draft={makeDraft([
          ...capOnly,
          { type: "before", name: "BuildVoidRay", time_lt: 400 },
        ])}
      />,
    );
    expect(screen.queryByText(warning)).toBeNull();
  });
});

describe("BuildEditorRules repeated source rows", () => {
  const twoStargateDraft = makeDraft(
    [{ type: "before", name: "BuildStargate", time_lt: 200 }],
    { name: "PvZ - 2 Stargate Void Ray", vsRace: "Zerg" },
  );

  it("offers the 2nd Stargate as 'At least 2'", () => {
    const addRuleFromEvent = vi.fn();
    renderRules({
      draft: twoStargateDraft,
      sourceRows: [stargate(170), stargate(230)],
      addRuleFromEvent,
    });

    expect(screen.getAllByText("In rules")).toHaveLength(1);
    const chip = screen.getByRole("button", {
      name: "Add rule: at least 2 Stargates before 4:20",
    });
    expect(chip.textContent).toBe("At least 2");
    expect(chip.title).toBe(
      "Count this one too. Adds “At least 2” before 4:20; the first Stargate rule stays.",
    );
    fireEvent.click(chip);
    expect(addRuleFromEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "BuildStargate",
      time: 230,
    }));
    expect(liveRegion()?.textContent).toBe(
      "Added: at least 2 Stargates before 4:20.",
    );

    // Edit mode: the rows are the saved rules' deadlines, not Stargates.
    cleanup();
    renderRules({
      draft: twoStargateDraft,
      sourceRows: [stargate(170), stargate(230)],
      countRepeats: false,
      addRuleFromEvent,
    });
    expect(screen.getAllByText("In rules")).toHaveLength(2);
    expect(screen.getByText("Saved rule times (2)")).toBeTruthy();
    expect(screen.queryByRole("button", {
      name: "Add rule: at least 2 Stargates before 4:20",
    })).toBeNull();
  });

  it("names the rule a 3rd Stargate raises in place", () => {
    renderRules({
      draft: makeDraft([
        { type: "before", name: "BuildStargate", time_lt: 200 },
        { type: "count_min", name: "BuildStargate", count: 2, time_lt: 260 },
      ]),
      sourceRows: [stargate(170), stargate(230), stargate(280)],
    });

    const chip = screen.getByRole("button", {
      name: "Change rule 2 to at least 3 Stargates before 5:10",
    });
    expect(chip.title).toBe(
      "Count this one too. Changes rule 2 to “At least 3” before 5:10.",
    );
    fireEvent.click(chip);
    expect(liveRegion()?.textContent).toBe(
      "Changed rule 2: at least 3 Stargates before 5:10.",
    );
  });

  it("name check offers Require 2 and calls addRuleFromEvent with the 2nd Stargate row", () => {
    const addRuleFromEvent = vi.fn();
    renderRules({
      draft: twoStargateDraft,
      sourceRows: [stargate(170), stargate(230)],
      addRuleFromEvent,
    });

    expect(screen.getByText(
      "The build name says “2 Stargate”, but your rules pass with 1 Stargate.",
    )).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Require 2" }));
    expect(addRuleFromEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "BuildStargate",
      time: 230,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Dismiss this name check" }));
    expect(screen.queryByText(/The build name says/)).toBeNull();
  });

  it("name check asks for a manual raise in edit mode", () => {
    renderRules({
      draft: twoStargateDraft,
      sourceRows: [stargate(170), stargate(230)],
      countRepeats: false,
    });

    expect(screen.getByText(
      "The build name says “2 Stargate”, but your rules pass with 1 Stargate. Raise the number on that rule and check its time.",
    )).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Require 2" })).toBeNull();
  });
});

describe("BuildEditorRules glyphs", () => {
  it("rules section contains no ≥ ≤ ✓ ✗ ⚙ ★ glyphs", () => {
    renderRules({
      draft: makeDraft([
        { type: "before", name: "BuildStargate", time_lt: 200 },
        { type: "not_before", name: "BuildRoboticsFacility", time_lt: 240 },
        { type: "count_max", name: "BuildPhoenix", count: 2, time_lt: 300 },
        { type: "count_exact", name: "BuildOracle", count: 1, time_lt: 300 },
        { type: "count_min", name: "BuildVoidRay", count: 3, time_lt: 420 },
        { type: "before", name: "BuildGateway", time_lt: 120, proxy: true },
        { type: "before", name: "", time_lt: 60 },
      ], { name: "PvZ - 2 Stargate Void Ray" }),
      errors: { rules: "Need at least one rule." },
      sourceRows: [stargate(170), stargate(230), { ...stargate(250), key: "x", what: "BuildFleetBeacon" }],
    });
    const section = screen.getByRole("region", { name: "Match rules" });
    const glyphs = /[≥≤✓✗⚙★▶]/;

    expect(section.textContent).not.toMatch(glyphs);
    for (const el of Array.from(section.querySelectorAll("[title], [aria-label]"))) {
      expect(el.getAttribute("title") ?? "").not.toMatch(glyphs);
      expect(el.getAttribute("aria-label") ?? "").not.toMatch(glyphs);
    }
  });
});
