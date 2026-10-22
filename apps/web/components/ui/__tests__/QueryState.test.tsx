import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryState, hasQueryData, type QueryLike } from "../QueryState";

afterEach(cleanup);

const SERVER_ERROR = { status: 500, code: "internal_error", message: "x", requestId: "req-1234abcd-5678" };

function q<T>(over: Partial<QueryLike<T>>): QueryLike<T> {
  return { data: undefined, error: undefined, mutate: vi.fn(), ...over };
}

function renderRows(query: QueryLike<string[]>) {
  return render(
    <QueryState
      q={query}
      skeleton={<p>skeleton</p>}
      isEmpty={(rows) => rows.length === 0}
      empty={<p>No matchups match</p>}
      filtered
    >
      {(rows, { isPreviousData }) => <p>{`rows:${rows.join(",")}${isPreviousData ? " (previous)" : ""}`}</p>}
    </QueryState>,
  );
}

describe("QueryState", () => {
  it("shows the skeleton while the first answer loads", () => {
    renderRows(q({}));
    expect(screen.getByText("skeleton")).toBeTruthy();
  });

  it("renders the error rather than the empty state when the request failed", () => {
    renderRows(q({ error: SERVER_ERROR }));
    expect(screen.getByTestId("request-error")).toBeTruthy();
    expect(screen.getByText("Something went wrong on our side")).toBeTruthy();
    expect(screen.getByText(/Your filters are still applied\./)).toBeTruthy();
    expect(screen.queryByText("No matchups match")).toBeNull();
    expect(screen.queryByText("skeleton")).toBeNull();
  });

  it("calls mutate when Retry is pressed", async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    renderRows(q({ error: SERVER_ERROR, mutate }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state only for a real, empty answer", () => {
    renderRows(q({ data: [] }));
    expect(screen.getByText("No matchups match")).toBeTruthy();
    expect(screen.queryByTestId("request-error")).toBeNull();
  });

  it("renders the data when there is some", () => {
    renderRows(q({ data: ["PvT", "PvZ"] }));
    expect(screen.getByText("rows:PvT,PvZ")).toBeTruthy();
  });

  it("keeps data on screen when only a background refresh failed", () => {
    renderRows(q({ data: ["PvT"], error: SERVER_ERROR }));
    expect(screen.getByText("rows:PvT")).toBeTruthy();
    expect(screen.queryByTestId("request-error")).toBeNull();
  });

  it("shows previous data while a filter change loads, and the error if that request fails", () => {
    const view = renderRows(q({ data: ["PvT"], isPreviousData: true }));
    expect(screen.getByText("rows:PvT (previous)")).toBeTruthy();
    view.rerender(
      <QueryState q={q({ data: ["PvT"], isPreviousData: true, error: SERVER_ERROR })} isEmpty={(r: string[]) => r.length === 0}>
        {(rows) => <p>{rows.join(",")}</p>}
      </QueryState>,
    );
    expect(screen.getByTestId("request-error")).toBeTruthy();
    expect(screen.queryByText("PvT")).toBeNull();
  });

  it("lets a view replace the error branch, e.g. a 404 that means not found", () => {
    render(
      <QueryState
        q={q({ error: { status: 404, code: "not_found", message: "Not found." } })}
        renderError={(error) =>
          (error as { status: number }).status === 404 ? <p>Not in your history</p> : undefined}
      />,
    );
    expect(screen.getByText("Not in your history")).toBeTruthy();
    expect(screen.queryByTestId("request-error")).toBeNull();
  });

  it("falls back to RequestError when renderError returns undefined", () => {
    render(<QueryState q={q({ error: SERVER_ERROR })} renderError={() => undefined} errorTitle="Opponents" />);
    expect(screen.getByText("Opponents")).toBeTruthy();
    expect(screen.getByTestId("request-error")).toBeTruthy();
  });
});

describe("hasQueryData", () => {
  it("is true for current data and for previous data still loading", () => {
    expect(hasQueryData(q({ data: [] }))).toBe(true);
    expect(hasQueryData(q({ data: [1], isPreviousData: true }))).toBe(true);
    expect(hasQueryData(q({ data: [1], error: SERVER_ERROR }))).toBe(true);
  });

  it("is false while loading and when the current request failed", () => {
    expect(hasQueryData(q({}))).toBe(false);
    expect(hasQueryData(q({ error: SERVER_ERROR }))).toBe(false);
    expect(hasQueryData(q({ data: [1], isPreviousData: true, error: SERVER_ERROR }))).toBe(false);
  });
});
