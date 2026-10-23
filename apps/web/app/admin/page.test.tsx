import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Dashboard from "./page";

const mocks = vi.hoisted(() => ({ loading: true, failed: false, counts: vi.fn(), recent: vi.fn(), storage: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "admin" }) }));
vi.mock("./components/useAdminEventsSocket", () => ({ useAdminEventsSocket: () => undefined }));
// Article loading has its own integration coverage. Keep this test focused on
// independent dashboard requests, including simultaneous failures.
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: () => null }));
vi.mock("@/lib/clientApi", () => ({ useApi: (url: string) => ({
  data: undefined,
  isLoading: mocks.loading,
  error: mocks.failed ? { status: 503, message: "Service unavailable", requestId: url } : undefined,
  mutate: url.includes("counts") ? mocks.counts : url.includes("storage") ? mocks.storage : mocks.recent,
}) }));
afterEach(() => { cleanup(); mocks.loading = true; mocks.failed = false; vi.clearAllMocks(); });

it("keeps one Dashboard heading while loading and after data settles", () => {
  const { rerender } = render(<Dashboard />);
  expect(screen.getAllByRole("heading", { level: 1, name: "Dashboard" })).toHaveLength(1);
  mocks.loading = false;
  rerender(<Dashboard />);
  expect(screen.getAllByRole("heading", { level: 1, name: "Dashboard" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(mocks.recent).toHaveBeenCalledTimes(1);
});

it("keeps failures recoverable while revalidating each independent source", () => {
  mocks.failed = true;
  render(<Dashboard />);
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  screen.getAllByRole("button", { name: "Retry" }).forEach((button) => fireEvent.click(button));
  expect(mocks.counts).toHaveBeenCalledTimes(1);
  expect(mocks.recent).toHaveBeenCalledTimes(1);
  expect(mocks.storage).toHaveBeenCalledTimes(1);
});
