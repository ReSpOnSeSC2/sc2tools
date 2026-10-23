import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ call: vi.fn(), token: vi.fn(async () => "token"), status: undefined as undefined | { status: string; generation?: string }, pending: false, mutate: vi.fn(), paths: [] as Array<string | null> }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: api.token }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: api.call, useApi: (path: string | null) => { api.paths.push(path); return path?.includes("reclassify-status") ? { data: api.status, mutate: api.mutate } : { data: { items: api.pending ? [{}] : [], total: api.pending ? 1 : 0, disabled: false }, mutate: vi.fn() }; } }));
vi.mock("@/components/build-checkin/BuildCheckInQueue", () => ({ BuildCheckInQueue: () => <div role="dialog">Pending build check-ins</div> }));
import { BuildDossierEmpty } from "./BuildDossierEmpty";
beforeEach(() => { api.call.mockReset(); api.status = undefined; api.pending = false; api.paths = []; api.mutate.mockReset(); });
afterEach(cleanup);

describe("zero-game matching recovery", () => {
  it("queues re-matching, stays honest while active, and refreshes only on its terminal completion", async () => {
    api.call.mockResolvedValue({ generation: "new-run" });
    const matched = vi.fn(); const edit = vi.fn();
    const view = render(<BuildDossierEmpty slug="my-build" onMatched={matched} onEditRules={edit} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit rules" }));
    expect(edit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Re-match replays" }));
    expect(screen.getByRole("status").textContent).toBe("Re-matching… this can take a minute");
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith({ status: "queued", generation: "new-run" }, { revalidate: true }));
    expect(api.call).toHaveBeenCalledWith(api.token, "/v1/custom-builds/my-build/reclassify", { method: "POST", body: JSON.stringify({ replace: true }) });
    expect(matched).not.toHaveBeenCalled();
    api.status = { status: "complete", generation: "new-run" };
    view.rerender(<BuildDossierEmpty slug="my-build" onMatched={matched} onEditRules={edit} />);
    await waitFor(() => expect(matched).toHaveBeenCalledOnce());
  });

  it("recognizes an existing job and mounts check-ins only when items are pending and requested", async () => {
    api.status = { status: "running" }; api.pending = true;
    render(<BuildDossierEmpty slug="my-build" onMatched={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe("Matching is running…");
    expect(screen.queryByRole("button", { name: "Re-match replays" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review check-ins" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("offers another attempt after failure with a support request ID", async () => {
    api.call.mockRejectedValue({ requestId: "req-match-123", message: "raw failure" });
    render(<BuildDossierEmpty slug="my-build" onMatched={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Review check-ins" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Re-match replays" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn't re-match replays. Try again. Error ID: req-match-123");
    expect(screen.getByRole("button", { name: "Re-match replays" })).toBeTruthy();
    expect(screen.queryByText("raw failure")).toBeNull();
  });
});
