import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDuration, TopPagesTable, BarBreakdown } from "./AnalyticsSections";
import { buildCsv, publicPageHref, shareLabel, validateDateRange } from "./analyticsExport";
import { AnalyticsRangePicker } from "./AnalyticsRangePicker";

afterEach(cleanup);
describe("analytics presentation", () => {
  it.each([[45, "45s"], [252, "4m 12s"], [3900, "1h 05m"], [0, "0s"]])("formats %s seconds with explicit units", (seconds, expected) => {
    expect(formatDuration(Number(seconds))).toBe(expected);
  });
  it("uses chart tokens, without fixed hex palette literals", () => {
    const source = readFileSync(`${__dirname}/AnalyticsSections.tsx`, "utf8");
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).toContain("useChartTheme()");
  });
  it("shows exact breakdown counts and shares, and links only safe public page paths", () => {
    render(<><TopPagesTable total={2000} rows={[{ path: "/download", title: "Download", views: 10, activeUsers: 3 }, { path: "/app?token=private", title: "Private", views: 1, activeUsers: 1 }]} />
      <BarBreakdown title="Channels" empty="None" rows={[{ label: "Direct", value: 1234 }, { label: "Search", value: 76 }]} /></>);
    expect(screen.getByRole("link", { name: /\/download/ }).getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("link", { name: /token=private/ })).toBeNull();
    expect(screen.getByText("0.5%")).toBeTruthy();
    expect(screen.getByText("1,234 · 94%")).toBeTruthy();
    expect(shareLabel(0, 0)).toBe("0%");
    expect(publicPageHref("//evil.example")).toBeNull();
    expect(publicPageHref("(not set)")).toBeNull();
  });
  it("escapes commas, quotes, newlines and spreadsheet formula prefixes", () => {
    expect(buildCsv([["=1+1", "+SUM(A1)", "-1", "@x", 'a,"b"\n']])).toBe('"\'=1+1","\'+SUM(A1)","\'-1","\'@x","a,""b""\n"');
  });
  it("validates custom windows before applying, including inclusive day count", () => {
    const onCustom = vi.fn();
    render(<AnalyticsRangePicker value={28} onPreset={vi.fn()} onCustom={onCustom} />);
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    const set = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
    set("From", "2026-01-12"); set("To", "2026-01-10");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert").textContent).toContain("From must be on or before To");
    expect(onCustom).not.toHaveBeenCalled();
    set("From", "2026-01-01"); set("To", "2026-01-10");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onCustom).toHaveBeenCalledWith("2026-01-01", "2026-01-10");
    expect(within(screen.getByRole("group", { name: "Date range" })).getAllByRole("button")).toHaveLength(6);
    expect(validateDateRange("2025-01-01", "2026-01-01", "2026-01-01")).toContain("365");
    expect(validateDateRange("2026-01-01", "2026-01-02", "2026-01-01")).toContain("today");
  });
});
