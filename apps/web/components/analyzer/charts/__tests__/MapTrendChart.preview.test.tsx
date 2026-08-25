import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapTrendChart } from "../MapTrendChart";

const useApiMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("@/lib/filterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/filterContext")>();
  return {
    ...actual,
    useFilters: () => ({ filters: { race: "P" }, dbRev: 3 }),
  };
});

vi.mock("@/lib/timeseries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/timeseries")>();
  return {
    ...actual,
    clientTimezone: () => "America/New_York",
  };
});

vi.mock("@/components/maps/MapPreviewDialog", () => ({
  MapPreviewDialog: ({
    mapName,
    onClose,
  }: {
    mapName: string | null;
    onClose: () => void;
  }) =>
    mapName ? (
      <div role="dialog" aria-label={`${mapName} map preview`}>
        <button type="button" onClick={onClose}>
          Close preview
        </button>
      </div>
    ) : null,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ComposedChart: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
}));

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
});

describe("MapTrendChart map preview", () => {
  it("opens an enlarged map from its native button on pointer or keyboard click", () => {
    useApiMock.mockReturnValue({
      isLoading: false,
      data: {
        interval: "day",
        points: [
          {
            bucket: "2026-08-20",
            key: "Ruby Rock",
            wins: 3,
            losses: 1,
            total: 4,
          },
        ],
      },
    });

    render(<MapTrendChart bucket="day" />);

    const trigger = screen.getByRole("button", {
      name: "View a larger image of Ruby Rock",
    });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.className).toContain("min-h-11");

    // Keyboard activation of a native button is delivered as a click with
    // detail=0; the same handler therefore works for touch, mouse, and keys.
    fireEvent.click(trigger, { detail: 0 });
    expect(
      screen.getByRole("dialog", { name: "Ruby Rock map preview" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
