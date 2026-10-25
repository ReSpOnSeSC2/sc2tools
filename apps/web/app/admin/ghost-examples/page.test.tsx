import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  userId: "owner", apiCall: vi.fn(), mutate: vi.fn(async () => undefined),
  forbidden: false, getToken: vi.fn(async () => "admin-token"),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: harness.userId, getToken: harness.getToken }) }));
vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => harness.apiCall(...args),
  useApi: (path: string | null) => {
    if (path === "/v1/admin/ghost-examples") return harness.forbidden
      ? { error: { status: 403, message: "Forbidden" } }
      : { data: { items: [] }, mutate: harness.mutate };
    if (path?.startsWith("/v1/replays")) return { data: { items: [{ gameId: "mine", date: "2026-10-23", map: "Alcyone", myBuild: "Blink expand" }] } };
    return {};
  },
}));

import AdminGhostExamplesPage from "./page";

const PREVIEW = {
  name: "Blink expand", matchup: "PvT", map: "Alcyone", stepCount: 1,
  description: "", previewToken: "reviewed-opening",
  target: { name: "Blink expand", steps: [{ name: "Gateway", t: 40, kind: "building", timing: "started" }] },
};

beforeEach(() => {
  harness.userId = "owner";
  harness.forbidden = false;
  harness.apiCall.mockResolvedValue(PREVIEW);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("curated Ghost examples", () => {
  it("requires a reviewed preview before exposing the explicit publish action", async () => {
    render(<AdminGhostExamplesPage />);
    expect(harness.apiCall).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Publish example for users" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Recent replay"), { target: { value: "mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview selected opening" }));
    expect(await screen.findByRole("button", { name: "Publish example for users" })).toBeTruthy();
    expect(screen.getByText("Gateway")).toBeTruthy();
    expect(harness.apiCall).toHaveBeenLastCalledWith(harness.getToken, "/v1/admin/ghost-examples/preview", {
      method: "POST", body: JSON.stringify({ gameId: "mine", side: "you", description: "" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish example for users" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(2));
    expect(harness.apiCall).toHaveBeenLastCalledWith(harness.getToken, "/v1/admin/ghost-examples", {
      method: "POST", body: JSON.stringify({ gameId: "mine", side: "you", description: "", previewToken: "reviewed-opening" }),
    });
    await waitFor(() => expect(harness.mutate).toHaveBeenCalled());
  });

  it("invalidates the reviewed preview when the selected player changes", async () => {
    render(<AdminGhostExamplesPage />);
    fireEvent.change(screen.getByLabelText("Replay game ID"), { target: { value: "mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview selected opening" }));
    await screen.findByRole("button", { name: "Publish example for users" });
    fireEvent.change(screen.getByLabelText("Build order to share"), { target: { value: "opponent" } });
    expect(screen.queryByRole("button", { name: "Publish example for users" })).toBeNull();
  });

  it("ignores a previous account's in-flight preview", async () => {
    let finish: (value: typeof PREVIEW) => void = () => undefined;
    harness.apiCall.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<AdminGhostExamplesPage />);
    fireEvent.change(screen.getByLabelText("Replay game ID"), { target: { value: "mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview selected opening" }));
    harness.userId = "another-account";
    rerender(<AdminGhostExamplesPage />);
    finish(PREVIEW);
    await waitFor(() => expect((screen.getByLabelText("Replay game ID") as HTMLInputElement).value).toBe(""));
    expect(screen.queryByRole("button", { name: "Publish example for users" })).toBeNull();
  });

  it("renders the shared admin gate when the server rejects access", () => {
    harness.forbidden = true;
    render(<AdminGhostExamplesPage />);
    expect(screen.getByText("403 — admin only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview selected opening" })).toBeNull();
  });
});
