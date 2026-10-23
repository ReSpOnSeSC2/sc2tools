import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import UsersPage from "./page";
const request = vi.hoisted(() => ({ error: { status: 500, message: "Unavailable", requestId: "users-reference" }, mutate: vi.fn() }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ ...request, data: undefined, isLoading: true }) }));
vi.mock("next/navigation", () => import("../components/__tests__/navigationFixture"));
afterEach(() => { cleanup(); request.error.status = 500; });
it("retains a single header and Retry while a failed first request revalidates", () => {
  render(<UsersPage />);
  expect(screen.getAllByRole("heading", { level: 1, name: "Users" })).toHaveLength(1);
  expect(screen.getByTitle("users-reference")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(request.mutate).toHaveBeenCalledTimes(1);
});
it("renders forbidden copy without header actions", () => {
  request.error.status = 403;
  render(<UsersPage />);
  expect(screen.getByText(/Your account isn't an admin/)).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Help/ })).toBeNull();
});
