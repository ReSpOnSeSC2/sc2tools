import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RadarChart, type RadarAxis } from "./RadarChart";

afterEach(cleanup);
const axes: RadarAxis[] = [
  { key: "a", label: "Early finish", value: 0 },
  { key: "b", label: "Expansion", value: 100 },
  { key: "c", label: "Economy", value: 60 },
  { key: "d", label: "Tech", value: 40 },
  { key: "e", label: "Air", value: 20 },
];

describe("RadarChart evidence handling", () => {
  it("names the chart and exposes values to assistive technology", () => {
    render(<RadarChart label="Player tendencies" axes={axes} />);
    const chart = screen.getByRole("img", { name: "Player tendencies" });
    expect(chart.querySelector("desc")?.textContent).toContain("Early finish: 0 of 100");
    expect(chart.querySelector("desc")?.textContent).toContain("Expansion: 100 of 100");
    expect(screen.getAllByTestId("radar-point")).toHaveLength(5);
    expect(screen.getByTestId("radar-area")).toBeTruthy();
  });
  it("does not join unknown values into an invented polygon", () => {
    render(<RadarChart label="Incomplete" axes={axes.map((axis, i) => i === 1 ? { ...axis, value: null } : axis)} />);
    expect(screen.queryByTestId("radar-area")).toBeNull();
    expect(screen.getAllByTestId("radar-point")).toHaveLength(4);
    expect(screen.getByRole("img").querySelector("desc")?.textContent).toContain("Expansion: unavailable");
  });
  it("clamps invalid extremes and never writes NaN coordinates", () => {
    const { container } = render(<RadarChart label="Defensive" axes={axes.map((axis, i) => ({ ...axis, value: [NaN, Infinity, -2, 120, 0][i] }))} />);
    expect(container.innerHTML).not.toContain("NaN");
    expect(container.innerHTML).not.toContain("Infinity");
    expect(screen.getAllByTestId("radar-point")).toHaveLength(3);
  });
  it("gives multiple charts distinct accessible descriptions", () => {
    render(<><RadarChart label="First" axes={axes} /><RadarChart label="Second" axes={axes} /></>);
    const charts = screen.getAllByRole("img");
    expect(charts[0].getAttribute("aria-describedby")).not.toBe(charts[1].getAttribute("aria-describedby"));
  });
});
