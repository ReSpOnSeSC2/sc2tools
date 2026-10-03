import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuleRow, type RuleRowProps } from "./BuildEditorRuleRow";
import type { BuildRule } from "@/lib/build-rules";
import { withCount } from "@/lib/build-rules-quantity";

afterEach(cleanup);

const NO_CONTEXT = { sameTokenElsewhere: false, higherFloorElsewhere: false };

function renderRow(rule: BuildRule, overrides: Partial<RuleRowProps> = {}) {
  const props: RuleRowProps = {
    rule,
    index: 0,
    ctx: NO_CONTEXT,
    onUpdate: vi.fn(),
    onQuantity: vi.fn(),
    onCount: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  const view = render(
    <ul>
      <RuleRow {...props} />
    </ul>,
  );
  return { ...view, props };
}

const picker = () =>
  screen.getByRole("combobox", { name: "How many" }) as HTMLSelectElement;
const countBox = () =>
  screen.queryByRole("spinbutton", { name: "Count" }) as HTMLInputElement | null;

describe("RuleRow", () => {
  it("before rule shows At least and 1; typing 2 calls onCount(2)", () => {
    const { props } = renderRow({ type: "before", name: "BuildVoidRay", time_lt: 400 });

    expect(picker().value).toBe("at_least");
    expect(picker().selectedOptions[0]?.textContent).toBe("At least");
    expect(countBox()?.value).toBe("1");
    expect(countBox()?.min).toBe("1");

    fireEvent.change(countBox()!, { target: { value: "2" } });
    expect(props.onCount).toHaveBeenCalledWith(2);
  });

  it("choosing Exactly calls onQuantity('exactly', 1)", () => {
    const { props } = renderRow({ type: "before", name: "BuildVoidRay", time_lt: 400 });

    fireEvent.change(picker(), { target: { value: "exactly" } });
    expect(props.onQuantity).toHaveBeenCalledWith("exactly", 1);
    expect(
      Array.from(picker().options, (option) => option.textContent),
    ).toEqual(["At least", "Exactly", "At most", "None"]);
  });

  it("None hides the count and reads 'at 4:00 or later, or never, is fine'", () => {
    renderRow({ type: "not_before", name: "BuildRoboticsFacility", time_lt: 240 });

    expect(picker().value).toBe("none");
    expect(countBox()).toBeNull();
    expect(screen.getByRole("group", {
      name: "Rule 1: Passes when no Robotics Facility starts before 4:00 — at 4:00 or later, or never, is fine.",
    })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Before 4:00, change time" }).title)
      .toMatch(/^Fails if one starts before this game time/);
  });

  it("At most reads 'games with none pass too'", () => {
    renderRow({ type: "count_max", name: "BuildStargate", count: 1, time_lt: 360 });

    expect(picker().value).toBe("at_most");
    expect(countBox()?.min).toBe("0");
    const note = screen.getByText("— games with none pass too.", { exact: false });
    expect(note.className).toContain("text-warning");
    expect(screen.getByRole("group", {
      name: "Rule 1: Passes with 0 or 1 Stargate started before 6:00 — games with none pass too.",
    })).toBeTruthy();
  });

  it("Exactly 0 reads 'works the same as None'", () => {
    renderRow({ type: "count_exact", name: "BuildStargate", count: 0, time_lt: 300 });

    expect(countBox()?.value).toBe("0");
    expect(screen.getByRole("group", {
      name: /^Rule 1: Passes when no Stargate starts before 5:00 — 0 works the same as None\.$/,
    })).toBeTruthy();
  });

  it("wheel over the count box does not call onCount", () => {
    const { props } = renderRow({
      type: "count_min", name: "BuildStargate", count: 2, time_lt: 260,
    });

    fireEvent.wheel(countBox()!, { deltaY: -100 });
    fireEvent.wheel(countBox()!, { deltaY: 100 });
    expect(props.onCount).not.toHaveBeenCalled();
    expect(countBox()?.value).toBe("2");
  });

  it("an emptied count box restores the stored number on blur", () => {
    const { props } = renderRow({
      type: "count_min", name: "BuildStargate", count: 3, time_lt: 260,
    });

    fireEvent.change(countBox()!, { target: { value: "" } });
    expect(props.onCount).not.toHaveBeenCalled();
    fireEvent.blur(countBox()!);
    expect(countBox()?.value).toBe("3");
  });

  it("keeps the count box focused while before becomes count_min", () => {
    function StatefulRow() {
      const [rule, setRule] = useState<BuildRule>({
        type: "before", name: "BuildVoidRay", time_lt: 400,
      });
      return (
        <ul>
          <RuleRow
            rule={rule}
            index={0}
            ctx={NO_CONTEXT}
            onUpdate={vi.fn()}
            onQuantity={vi.fn()}
            onCount={(n) => setRule((cur) => withCount(cur, n))}
            onRemove={vi.fn()}
          />
        </ul>
      );
    }
    render(<StatefulRow />);
    const box = countBox()!;
    box.focus();

    fireEvent.change(box, { target: { value: "4" } });
    expect(countBox()).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe("4");
    // textContent, not the group name: jsdom has no inline layout, so its
    // accessible-name walk puts a space between the time and the ".".
    expect(screen.getByText("4 or more").closest("p")?.textContent).toBe(
      "Passes with 4 or more Void Rays started before 6:40.",
    );
  });

  it("remembers the last number when None turns back into a count", () => {
    const onQuantity = vi.fn();
    const { rerender } = renderRow(
      { type: "count_max", name: "BuildStargate", count: 3, time_lt: 360 },
      { onQuantity },
    );
    const props = { index: 0, ctx: NO_CONTEXT, onUpdate: vi.fn(), onCount: vi.fn(), onRemove: vi.fn() };
    rerender(
      <ul>
        <RuleRow
          {...props}
          rule={{ type: "not_before", name: "BuildStargate", time_lt: 360 }}
          onQuantity={onQuantity}
        />
      </ul>,
    );

    fireEvent.change(picker(), { target: { value: "exactly" } });
    expect(onQuantity).toHaveBeenCalledWith("exactly", 3);
  });

  it("Enter commits a typed time and Escape cancels", () => {
    const { props } = renderRow({ type: "before", name: "BuildVoidRay", time_lt: 400 });
    const timeButton = screen.getByRole("button", { name: "Before 6:40, change time" });
    expect(timeButton.title).toMatch(/^Only what starts before this game time counts/);

    fireEvent.click(timeButton);
    const editor = screen.getByRole("textbox", { name: "Before (game time, m:ss)" });
    fireEvent.change(editor, { target: { value: "5:10" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(props.onUpdate).toHaveBeenCalledWith({ time_lt: 310 });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Before 6:40, change time" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Before 6:40, change time" }));
    const again = screen.getByRole("textbox", { name: "Before (game time, m:ss)" });
    fireEvent.change(again, { target: { value: "9:00" } });
    // The editor modal closes on a document-level Escape; this one must not reach it.
    const onDocumentKey = vi.fn();
    document.addEventListener("keydown", onDocumentKey);
    fireEvent.keyDown(again, { key: "Escape" });
    document.removeEventListener("keydown", onDocumentKey);
    expect(onDocumentKey).not.toHaveBeenCalled();
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "Before (game time, m:ss)" })).toBeNull();
  });

  it("proxy chip only for buildings or when already on", () => {
    renderRow({ type: "before", name: "BuildMarine", time_lt: 120 });
    expect(screen.queryByRole("checkbox")).toBeNull();
    cleanup();

    const { props } = renderRow({ type: "before", name: "BuildBarracks", time_lt: 120 });
    const chip = screen.getByRole("checkbox", { name: "Only count proxied Barracks" });
    expect((chip as HTMLInputElement).checked).toBe(false);
    expect(chip.closest("label")?.title).toMatch(/^Only count Barracks placed more than 50 world units/);
    fireEvent.click(chip);
    expect(props.onUpdate).toHaveBeenCalledWith({ proxy: true });
    cleanup();

    // Proxy left on a unit stays visible (and enabled) so it can be unticked.
    renderRow({ type: "before", name: "BuildMarine", time_lt: 120, proxy: true });
    const stuck = screen.getByRole("checkbox", { name: "Only count proxied Marines" });
    expect((stuck as HTMLInputElement).disabled).toBe(false);
    expect(stuck.closest("label")?.title).toBe(
      "Only works for buildings. Enter one, such as BuildPylon, or untick this before saving.",
    );
    cleanup();

    renderRow({ type: "before", name: "", time_lt: 60, proxy: true });
    expect(screen.getByRole("checkbox", { name: "Only count proxied buildings" })).toBeTruthy();
  });

  it("group is labelled 'Rule 1:' plus the read-back", () => {
    const { props } = renderRow({ type: "before", name: "BuildVoidRay", time_lt: 400 });

    expect(screen.getByRole("group", {
      name: "Rule 1: Passes with 1 or more Void Rays started before 6:40 — one is enough.",
    })).toBeTruthy();
    const readoutId = picker().getAttribute("aria-describedby");
    expect(readoutId).toBeTruthy();
    expect(countBox()?.getAttribute("aria-describedby")).toBe(readoutId);
    expect(screen.getByRole("textbox", { name: "Unit, building or upgrade" })).toBeTruthy();

    const remove = screen.getByRole("button", {
      name: "Remove rule 1: at least 1 Void Ray before 6:40",
    });
    expect(remove.title).toBe("Remove rule");
    fireEvent.click(remove);
    expect(props.onRemove).toHaveBeenCalledTimes(1);
  });
});
