import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SegmentedControl } from "../SegmentedControl";

afterEach(cleanup);

const OPTIONS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;

type Value = (typeof OPTIONS)[number]["value"];

function Harness({ onChange }: { onChange?: (v: Value) => void }) {
  const [value, setValue] = useState<Value>("week");
  return (
    <SegmentedControl
      label="Bucket size"
      value={value}
      options={OPTIONS}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

describe("SegmentedControl", () => {
  it("is a named radio group with the value checked and one tab stop", () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup", { name: "Bucket size" })).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("Home and End jump to the first and last option", () => {
    render(<Harness />);
    const week = screen.getByRole("radio", { name: "Week" });
    fireEvent.keyDown(week, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Day" }));
    expect(screen.getByRole("radio", { name: "Day" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("radio", { name: "Month" }).getAttribute("aria-checked")).toBe("true");
  });

  it("does not report a change when the checked option is clicked again", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Week" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Month" }));
    expect(onChange).toHaveBeenCalledWith("month");
  });

  it("keeps the first option tabbable when no option matches the value", () => {
    render(
      <SegmentedControl label="Pick" value={"none" as string} options={OPTIONS} onChange={() => undefined} />,
    );
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });
});
