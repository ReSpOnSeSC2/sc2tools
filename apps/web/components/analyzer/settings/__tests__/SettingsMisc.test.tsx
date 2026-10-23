/**
 * Settings → Misc: the default tab starts on Today, "Run setup again"
 * links to /welcome, and the analytics row shows and changes the real
 * consent for this browser (the cookie banner's store) instead of a
 * saved switch nothing read. Retired keys are dropped on the next save.
 * The API and Clerk are MOCKS; the consent store is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import { readConsent, setConsent } from "@/lib/analytics/consent";
import { SettingsMisc, miscForSave } from "../SettingsMisc";

const mocks = vi.hoisted(() => ({
  misc: {} as Record<string, unknown>,
  apiCall: vi.fn(),
  configured: true,
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token" }) }));

vi.mock("@/lib/clientApi", () => ({
  useApi: () => ({ data: mocks.misc, isLoading: false, error: null, mutate: async () => mocks.misc }),
  apiCall: mocks.apiCall,
}));

vi.mock("@/lib/analytics/consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/consent")>()),
  isAnalyticsConfigured: () => mocks.configured,
}));

beforeEach(() => {
  mocks.misc = {};
  mocks.configured = true;
  mocks.apiCall.mockReset();
  mocks.apiCall.mockResolvedValue({});
  window.localStorage.clear();
});

afterEach(cleanup);

function renderMisc() {
  return render(
    <ToastProvider>
      <SettingsMisc />
    </ToastProvider>,
  );
}

function analyticsStatus() {
  return screen.getByRole("status").textContent;
}

describe("SettingsMisc default tab", () => {
  it("lists Today first and shows it when nothing is chosen", () => {
    renderMisc();
    const select = screen.getByLabelText("Default tab") as HTMLSelectElement;
    expect(select.value).toBe("today");
    expect(within(select).getAllByRole("option")[0].textContent).toBe("Today (default)");
  });

  it("shows a saved choice", () => {
    mocks.misc = { defaultTab: "battlefield" };
    renderMisc();
    expect((screen.getByLabelText("Default tab") as HTMLSelectElement).value).toBe("battlefield");
  });

  it("saves without the retired wizard and telemetry keys", async () => {
    mocks.misc = { defaultTab: "trends", showWizardOnNextLogin: true, analytics: true };
    renderMisc();
    fireEvent.change(screen.getByLabelText("Default tab"), { target: { value: "macro" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    });
    expect(mocks.apiCall).toHaveBeenCalledWith(expect.anything(), "/v1/me/preferences/misc", {
      method: "PUT",
      body: JSON.stringify({ defaultTab: "macro" }),
    });
  });

  it("drops only the retired keys", () => {
    expect(miscForSave({ defaultTab: "today", analytics: true, showWizardOnNextLogin: false } as never)).toEqual({
      defaultTab: "today",
    });
  });
});

describe("SettingsMisc setup and analytics", () => {
  it("links to the setup guide instead of a wizard switch", () => {
    renderMisc();
    expect(screen.getByRole("link", { name: "Run setup again" }).getAttribute("href")).toBe("/welcome");
    expect(screen.queryByText(/first-run wizard/i)).toBeNull();
    expect(screen.queryByText(/telemetry/i)).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows that no choice was made yet, and can keep analytics off", () => {
    renderMisc();
    expect(analyticsStatus()).toBe("Analytics cookies: Not chosen yet");
    expect(screen.getByText("Applies to this browser")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep analytics cookies off" }));
    expect(readConsent()).toBe("denied");
    expect(analyticsStatus()).toBe("Analytics cookies: Off");
    expect(screen.queryByRole("button", { name: "Keep analytics cookies off" })).toBeNull();
    // Focus stays in the row rather than falling back to the page.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Turn on analytics cookies" }));
  });

  it("turns analytics on and off right away, without Save", () => {
    setConsent("denied");
    renderMisc();
    expect(analyticsStatus()).toBe("Analytics cookies: Off");
    fireEvent.click(screen.getByRole("button", { name: "Turn on analytics cookies" }));
    expect(readConsent()).toBe("granted");
    expect(analyticsStatus()).toBe("Analytics cookies: On");
    fireEvent.click(screen.getByRole("button", { name: "Turn off analytics cookies" }));
    expect(readConsent()).toBe("denied");
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("follows a choice made in the cookie banner", async () => {
    renderMisc();
    act(() => setConsent("granted"));
    await waitFor(() => expect(analyticsStatus()).toBe("Analytics cookies: On"));
  });

  it("says so when the site doesn't use analytics", () => {
    mocks.configured = false;
    renderMisc();
    expect(analyticsStatus()).toBe("Analytics cookies: Not used");
    expect(screen.getByText(/doesn't use analytics cookies/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /analytics cookies/ })).toBeNull();
  });
});
