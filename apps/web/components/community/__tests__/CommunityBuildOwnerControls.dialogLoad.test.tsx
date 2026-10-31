import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CommunityBuildOwnerControls } from "../CommunityBuildOwnerControls";

const harness = vi.hoisted(() => ({
  dialogLoads: 0,
  apiCall: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

// A deploy replaced the removal dialog's chunk, so it cannot load.
vi.mock("../CommunityRemoveDialog", () => {
  harness.dialogLoads += 1;
  throw new Error("chunk failed to load");
});

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
  useApi: () => ({ data: { items: [{ slug: "blink-pressure", sourceSlug: "private-blink" }] } }),
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: { success: harness.success, error: harness.error } }),
}));

afterEach(() => cleanup());

describe("CommunityBuildOwnerControls' removal dialog, loaded on demand", () => {
  test("starts loading once an owner's controls show, and says so when it cannot open", async () => {
    render(<CommunityBuildOwnerControls slug="blink-pressure" title="Blink Pressure" />);
    // Loaded before Remove is chosen, so the dialog is usually ready by then.
    await waitFor(() => expect(harness.dialogLoads).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "Remove from Community" }));
    await waitFor(() =>
      expect(harness.error).toHaveBeenCalledWith("Couldn’t open the removal dialog", {
        description: "Reload the page and try again.",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(harness.apiCall).not.toHaveBeenCalled();
  });
});
