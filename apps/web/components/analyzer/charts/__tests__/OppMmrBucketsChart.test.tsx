import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OppMmrBucketsChart } from "../OppMmrBucketsChart";

const useApiMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("@/lib/filterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/filterContext")>();
  return {
    ...actual,
    useFilters: () => ({ filters: { race: "P" }, dbRev: 7 }),
  };
});

vi.mock("../OppMmrBucketGamesModal", () => ({
  OppMmrBucketGamesModal: ({ band }: { band: { lo: number; hi: number } | null }) =>
    band ? <div data-testid="band-drilldown">{`${band.lo}-${band.hi}`}</div> : null,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ComposedChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
  Cell: () => null,
}));

/** Two adjacent bands of the given width, starting at 4500. */
function responseAt(width: 50 | 100 | 500) {
  return {
    bucketWidth: width,
    buckets: [
      {
        lo: 4500,
        hi: 4500 + width,
        label: "",
        wins: 30,
        losses: 10,
        total: 40,
        winRate: 0.75,
        avgMmr: 4700,
        minMmr: 4501,
        maxMmr: 4500 + width - 1,
      },
      {
        lo: 4500 + width,
        hi: 4500 + 2 * width,
        label: "",
        wins: 42,
        losses: 58,
        total: 100,
        winRate: 0.42,
        avgMmr: 5200,
        minMmr: 4500 + width + 1,
        maxMmr: 4500 + 2 * width - 1,
      },
    ],
    unknown: { total: 12, wins: 5, losses: 7 },
  };
}

function widthButton(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

const AUTO = "Choose the band width automatically";
const at = (width: number) => `Group opponents into ${width}-MMR bands`;

function lastRequest(): string {
  const calls = useApiMock.mock.calls;
  return String(calls[calls.length - 1]?.[0]);
}

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
});

describe("OppMmrBucketsChart width toggle", () => {
  it("opens on 500-MMR bands and asks the API for them", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: responseAt(500) });

    render(<OppMmrBucketsChart />);

    const request = String(useApiMock.mock.calls[0]?.[0]);
    expect(request).toContain("/v1/opp-mmr-buckets?");
    expect(request).toContain("bucket_width=500");
    expect(request).toContain("race=P");
    expect(request).toContain("#7");

    expect(widthButton(at(500)).getAttribute("aria-pressed")).toBe("true");
    expect(widthButton(at(100)).getAttribute("aria-pressed")).toBe("false");
    expect(widthButton(AUTO).getAttribute("aria-pressed")).toBe("false");

    // The caption and the tiles both describe 500-wide brackets.
    expect(screen.getByText(/Each bar = a 500-MMR band/)).toBeTruthy();
    expect(screen.getByText("4500–4999")).toBeTruthy();
    expect(screen.getByText("5000–5499")).toBeTruthy();
  });

  it("offers every server-supported width, narrowest first", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: responseAt(500) });

    render(<OppMmrBucketsChart />);

    const group = screen.getByRole("group", { name: "Opponent MMR band width" });
    expect(
      Array.from(group.querySelectorAll("button")).map((b) => b.textContent),
    ).toEqual(["Auto", "50", "100", "500"]);
  });

  it("does not credit Auto with a width the user picked", () => {
    // Regression: the badge read straight off the response, so
    // selecting 500 turned the button into "Auto (500)" — claiming an
    // automatic choice that never happened.
    useApiMock.mockReturnValue({ isLoading: false, data: responseAt(500) });

    render(<OppMmrBucketsChart />);

    expect(widthButton(AUTO).textContent).toBe("Auto");
  });

  it("hands the choice back to the server on Auto, and reports what it chose", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: responseAt(500) });
    render(<OppMmrBucketsChart />);

    useApiMock.mockReturnValue({ isLoading: false, data: responseAt(100) });
    fireEvent.click(widthButton(AUTO));

    expect(lastRequest()).toContain("bucket_width=auto");
    expect(widthButton(AUTO).getAttribute("aria-pressed")).toBe("true");
    expect(widthButton(AUTO).textContent).toBe("Auto(100)");
    expect(screen.getByText(/Each bar = a 100-MMR band/)).toBeTruthy();
  });

  it("keeps the narrower widths one tap away", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: responseAt(500) });
    render(<OppMmrBucketsChart />);

    useApiMock.mockReturnValue({ isLoading: false, data: responseAt(50) });
    fireEvent.click(widthButton(at(50)));

    expect(lastRequest()).toContain("bucket_width=50");
    expect(widthButton(at(50)).getAttribute("aria-pressed")).toBe("true");
    expect(widthButton(at(500)).getAttribute("aria-pressed")).toBe("false");
    expect(widthButton(AUTO).textContent).toBe("Auto");
    expect(screen.getByText("4500–4549")).toBeTruthy();
  });

  it("drills into the games behind a band at whatever width is showing", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: responseAt(500) });
    render(<OppMmrBucketsChart />);

    expect(screen.queryByTestId("band-drilldown")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "List the 100 games against 5000–5499 MMR opponents",
      }),
    );
    expect(screen.getByTestId("band-drilldown").textContent).toBe("5000-5500");
  });
});
