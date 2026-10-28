import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PersonalChartCacheTile, readPersonalChartCache } from "./PersonalChartCacheTile";

const counters = (patch = {}) => ({ hit: 3, miss: 4, entries: 2, bytes: 1000, reserved_bytes: 512, ...patch });
afterEach(cleanup);

function figure(label: string) {
  return screen.getByText(label).nextElementSibling?.textContent;
}

describe("personal chart cache card", () => {
  it("reports OFF explicitly without activity figures, links or activation controls", () => {
    render(<PersonalChartCacheTile snapshot={{ enabled: false, counters: null }} />);
    expect(screen.getByRole("status").textContent).toBe("Off");
    expect(screen.getByText(/normal API path/)).toBeTruthy();
    expect(screen.queryByRole("definition")).toBeNull();
    expect(screen.queryByText("Cache hits")).toBeNull(); expect(screen.queryByText("0 B")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull(); expect(screen.queryByRole("link")).toBeNull();
  });
  it("labels real enabled counters and cache accounting without making a savings claim", () => {
    render(<PersonalChartCacheTile snapshot={{ enabled: true, counters: counters() }} />);
    const card = screen.getByRole("region", { name: "Personal chart cache" });
    expect(within(card).getByRole("status").textContent).toBe("Enabled");
    expect(figure("Cache hits")).toBe("3"); expect(figure("Cache misses")).toBe("4");
    expect(figure("Stored entries")).toBe("2"); expect(figure("Accounted bytes")).toBe("1.00 kB");
    expect(figure("Reserved bytes")).toBe("512 B");
    expect(card.textContent).toContain("this API process since restart");
    expect(card.textContent).toContain("not total process memory");
    expect(card.textContent).not.toMatch(/saved|speedup|hit rate|%/i);
    expect(screen.queryByText("Status: Disabled")).toBeNull();
  });
  it("keeps valid enabled zero observations distinct from OFF and unavailable", () => {
    render(<PersonalChartCacheTile snapshot={{ enabled: true, counters: counters({ hit: 0, miss: 0, entries: 0, bytes: 0, reserved_bytes: 0 }) }} />);
    expect(screen.getByRole("status").textContent).toBe("Enabled");
    expect(figure("Cache hits")).toBe("0"); expect(figure("Stored entries")).toBe("0");
    expect(figure("Accounted bytes")).toBe("0 B");
    expect(screen.queryByText("Not reported")).toBeNull(); expect(screen.queryByText("Off", { exact: true })).toBeNull();
  });
  it.each([
    undefined, null, {}, { enabled: "false", counters: null }, { enabled: false, counters: counters() },
    { enabled: true, counters: null }, { enabled: true, counters: counters(), extra: 1 },
    { enabled: true, counters: { ...counters(), private: "unexpected" } },
    ...[NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(hit => ({ enabled: true, counters: counters({ hit }) })),
    { enabled: true, counters: counters({ entries: 513 }) },
    { enabled: true, counters: counters({ bytes: 64 * 1024 * 1024, reserved_bytes: 1 }) },
    { enabled: true, counters: counters({ miss: undefined }) },
  ])("does not infer disabled or zero activity from missing/malformed reporting %#", value => {
    expect(readPersonalChartCache(value)).toBeNull();
    render(<PersonalChartCacheTile snapshot={value} />);
    expect(screen.getByRole("status").textContent).toBe("Not reported");
    expect(screen.queryByText("Status: Disabled")).toBeNull(); expect(screen.queryByText("Cache hits")).toBeNull();
    expect(screen.queryByText(/NaN|Infinity|unexpected/)).toBeNull();
  });
});
