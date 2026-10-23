import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const harness = vi.hoisted(() => ({
  data: undefined as unknown,
  error: undefined as unknown,
  mutate: vi.fn(async () => undefined),
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "token"),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  bump: vi.fn(),
  prefsRevision: 0,
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken, isLoaded: true, isSignedIn: true }),
}));
vi.mock("@/components/ui/Toast", () => ({
  useToastOptional: () => ({ toast: harness.toast }),
}));
vi.mock("../BuildCheckInProvider", () => ({
  useBuildCheckInRevision: () => ({ revision: 0, bump: harness.bump }),
  useBuildCheckInPrefsRevision: () => harness.prefsRevision,
}));
vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => harness.apiCall(...args),
  useApi: (path: string) => {
    expect(path).toBe("/v1/me/preferences/buildCheckin");
    return {
      data: harness.data,
      error: harness.error,
      isLoading: harness.data === undefined && harness.error === undefined,
      mutate: harness.mutate,
    };
  },
}));

import { BuildCheckInSettings } from "../BuildCheckInSettings";

afterEach(() => {
  cleanup();
  harness.data = undefined;
  harness.error = undefined;
  harness.mutate.mockClear();
  harness.apiCall.mockReset();
  harness.toast.success.mockReset();
  harness.toast.error.mockReset();
  harness.bump.mockReset();
  harness.prefsRevision = 0;
});

const switchFor = (name: string) => screen.getByRole("switch", { name });

describe("BuildCheckInSettings", () => {
  it("defaults every switch to on when nothing is stored", () => {
    harness.data = {};
    render(<BuildCheckInSettings />);
    expect(screen.getByRole("heading", { name: "Build check-in" })).toBeTruthy();
    for (const name of ["Build check-ins", "Ask during the loading screen", "Ask after each game"]) {
      expect(switchFor(name).getAttribute("aria-checked")).toBe("true");
    }
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
  });

  it("opens the step-by-step guide in the help panel", async () => {
    harness.data = {};
    render(<BuildCheckInSettings />);
    const link = () => screen.getByRole("link", { name: "How build check-in works, step by step" });
    expect(link().getAttribute("href")).toBe("/help/build-check-in");
    await vi.waitFor(() => expect(link().getAttribute("aria-haspopup")).toBe("dialog"), { timeout: 10_000 });
  });

  it("disables the agent prompts while check-ins are off", () => {
    harness.data = { enabled: false, askAtLoading: true, askAfterGame: false };
    render(<BuildCheckInSettings />);
    expect(switchFor("Build check-ins").getAttribute("aria-checked")).toBe("false");
    expect(switchFor("Ask during the loading screen").hasAttribute("disabled")).toBe(true);
    expect(switchFor("Ask after each game").getAttribute("aria-checked")).toBe("false");
  });

  it("saves exactly the three flags and refreshes the header chip", async () => {
    harness.data = { enabled: true, askAtLoading: true, askAfterGame: true };
    harness.apiCall.mockResolvedValue({ enabled: true, askAtLoading: false, askAfterGame: true });
    render(<BuildCheckInSettings />);
    fireEvent.click(switchFor("Ask during the loading screen"));
    expect(screen.getByRole("region", { name: "Unsaved changes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(harness.toast.success).toHaveBeenCalledWith("Build check-in settings saved"),
    );
    expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, "/v1/me/preferences/buildCheckin", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, askAtLoading: false, askAfterGame: true }),
    });
    expect(harness.mutate).toHaveBeenCalledWith(
      { enabled: true, askAtLoading: false, askAfterGame: true },
      { revalidate: false },
    );
    expect(harness.bump).toHaveBeenCalledTimes(1);
  });

  it("reports a failed save and keeps the draft", async () => {
    harness.data = {};
    harness.apiCall.mockRejectedValue({ status: 429, code: "rate_limited", message: "x" });
    render(<BuildCheckInSettings />);
    fireEvent.click(switchFor("Build check-ins"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(harness.toast.error).toHaveBeenCalled());
    expect(harness.toast.error).toHaveBeenCalledWith("Couldn't save build check-in settings", {
      description: expect.stringMatching(/Too many check-in changes/),
    });
    expect(switchFor("Build check-ins").getAttribute("aria-checked")).toBe("false");
    expect(harness.bump).not.toHaveBeenCalled();
  });

  it("refetches the switches when the desktop app changes them", () => {
    harness.data = { enabled: true, askAtLoading: true, askAfterGame: true };
    const view = render(<BuildCheckInSettings />);
    expect(harness.mutate).not.toHaveBeenCalled();
    harness.prefsRevision = 1;
    view.rerender(<BuildCheckInSettings />);
    expect(harness.mutate).toHaveBeenCalledTimes(1);
    expect(harness.mutate).toHaveBeenCalledWith();

    // The refetched value replaces a clean draft.
    harness.data = { enabled: true, askAtLoading: false, askAfterGame: true };
    view.rerender(<BuildCheckInSettings />);
    expect(switchFor("Ask during the loading screen").getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
  });

  it("offers a retry when the settings can't load", () => {
    harness.error = { status: 503, message: "Something went wrong on our side." };
    render(<BuildCheckInSettings />);
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load your build check-in settings.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(harness.mutate).toHaveBeenCalled();
  });
});
