import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CommunityBuildOwnerControls } from "../CommunityBuildOwnerControls";

const harness = vi.hoisted(() => ({
  ownerStats: { items: [{ publicSlug: "blink-pressure" }] } as
    | { items: Array<{ publicSlug: string }> }
    | undefined,
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "test-token"),
  refresh: vi.fn(),
  replace: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: harness.refresh, replace: harness.replace }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
  useApi: () => ({ data: harness.ownerStats }),
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: { success: harness.success } }),
}));

describe("CommunityBuildOwnerControls", () => {
  beforeEach(() => {
    harness.ownerStats = { items: [{ publicSlug: "blink-pressure" }] };
    harness.apiCall.mockReset();
    harness.apiCall.mockResolvedValue(undefined);
    harness.getToken.mockClear();
    harness.refresh.mockClear();
    harness.replace.mockClear();
    harness.success.mockClear();
  });

  afterEach(() => cleanup());

  test("does not expose removal controls to another user", () => {
    harness.ownerStats = { items: [] };
    render(
      <CommunityBuildOwnerControls
        slug="blink-pressure"
        title="Blink Pressure"
        ownerUserId="owner-1"
      />,
    );

    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  test("gives the compact card action a mobile-safe touch target", () => {
    render(
      <CommunityBuildOwnerControls
        slug="blink-pressure"
        title="Blink Pressure"
        ownerUserId="owner-1"
        compact
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Remove “Blink Pressure” from Community" })
        .className,
    ).toContain("min-h-[44px]");
  });

  test("requires both confirmation layers before removing and refreshing", async () => {
    render(
      <CommunityBuildOwnerControls
        slug="blink-pressure"
        title="Blink Pressure"
        ownerUserId="owner-1"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove from Community" }),
    );
    expect(
      screen.getByRole("heading", {
        name: "Remove “Blink Pressure” from Community?",
      }),
    ).not.toBeNull();
    expect(harness.apiCall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("heading", { name: "Final confirmation" }),
    ).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("checkbox"));

    const remove = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Remove from Community",
    });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I understand this will remove/i,
      }),
    );
    expect((remove as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(remove);

    await waitFor(() => {
      expect(harness.apiCall).toHaveBeenCalledWith(
        harness.getToken,
        "/v1/community/builds/blink-pressure",
        { method: "DELETE" },
      );
    });
    expect(harness.success).toHaveBeenCalledWith(
      "Removed from Community",
      expect.objectContaining({
        description: expect.stringContaining("private build library"),
      }),
    );
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(harness.replace).not.toHaveBeenCalled();
  });

  test("keeps the final confirmation open and shows API errors", async () => {
    harness.apiCall.mockRejectedValueOnce(new Error("Service unavailable"));
    render(
      <CommunityBuildOwnerControls
        slug="blink-pressure"
        title="Blink Pressure"
        ownerUserId="owner-1"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove from Community" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Remove from Community",
      }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Service unavailable",
    );
    expect(
      screen.getByRole("heading", { name: "Final confirmation" }),
    ).not.toBeNull();
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  test("returns detail-page owners to the refreshed Community list", async () => {
    render(
      <CommunityBuildOwnerControls
        slug="blink-pressure"
        title="Blink Pressure"
        ownerUserId="owner-1"
        redirectAfterRemove
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove from Community" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Remove from Community",
      }),
    );

    await waitFor(() => expect(harness.replace).toHaveBeenCalledWith("/community"));
    expect(harness.refresh).toHaveBeenCalledTimes(1);
  });
});
