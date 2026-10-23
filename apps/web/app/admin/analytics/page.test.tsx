import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import AnalyticsPage from "./page";
const retry = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string) => ({ error: path.endsWith("realtime") ? { status: 500, message: "Unavailable" } : null, mutate: retry }) }));
afterEach(cleanup);
it("keeps realtime failures visible and retryable", () => {
  render(<AnalyticsPage />);
  expect(screen.getByText(/Realtime unavailable/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledTimes(1);
});
