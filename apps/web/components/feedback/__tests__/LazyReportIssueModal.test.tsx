import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LazyReportIssueModal } from "../LazyReportIssueModal";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "token", isLoaded: true, isSignedIn: true }),
}));
vi.mock("@/lib/clientApi", () => ({ apiCall: vi.fn(), useApi: () => ({ data: undefined }) }));

afterEach(cleanup);

describe("LazyReportIssueModal", () => {
  it("renders nothing while closed and loads the form when opened", async () => {
    const { rerender } = render(<LazyReportIssueModal open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(<LazyReportIssueModal open onClose={vi.fn()} prefill={{ type: "idea" }} />);
    expect(await screen.findByRole("dialog", { name: "Suggest a feature" })).toBeTruthy();
  });
});
