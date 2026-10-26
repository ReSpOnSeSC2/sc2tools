/**
 * Settings → Preferences: the default tab starts on Today, "Run setup again"
 * links to /welcome, and the analytics row shows and changes the real
 * consent for this browser (the cookie banner's store) instead of a
 * saved switch nothing read. Retired keys are dropped on the next save.
 * The API and Clerk are MOCKS; the consent store is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { ToastProvider } from "@/components/ui/Toast";
import { readConsent, setConsent } from "@/lib/analytics/consent";
import { SettingsMisc, miscForSave } from "../SettingsMisc";
import { SettingsShell } from "../SettingsShell";

const mocks = vi.hoisted(() => ({
  misc: {} as Record<string, unknown>,
  apiCall: vi.fn(),
  configured: true,
  ownerId: null as string | null,
  notifications: { muted: [] as string[] },
  routerPush: vi.fn(),
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: mocks.routerPush }),
}));

// Same-tab Next Link admission is synthetic. Native modifiers are left
// unhandled, matching Next's onNavigate contract; tests cancel JSDOM's
// navigation only after observing whether the component prevented it.
vi.mock("next/link", () => ({
  default: ({ href, children, onClick, onNavigate, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    onNavigate?: (event: { preventDefault: () => void }) => void;
  }) => <a href={href} {...props} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0
      || (event.currentTarget.target && event.currentTarget.target !== "_self") || event.currentTarget.hasAttribute("download")) return;
    let prevented = false;
    onNavigate?.({ preventDefault: () => { prevented = true; } });
    event.preventDefault();
    if (!prevented) mocks.routerPush(href);
  }}>{children}</a>,
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: mocks.ownerId, getToken: async () => "token" }) }));

vi.mock("@/lib/clientApi", () => ({
  useApi: (url: string) => ({ data: url.endsWith("/notifications") ? mocks.notifications : mocks.misc, isLoading: false, error: null, mutate: async () => mocks.misc }),
  apiCall: mocks.apiCall,
}));

vi.mock("@/lib/analytics/consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/consent")>()),
  isAnalyticsConfigured: () => mocks.configured,
}));

beforeEach(() => {
  mocks.misc = {};
  mocks.configured = true;
  mocks.ownerId = null;
  mocks.notifications = { muted: [] };
  mocks.apiCall.mockReset();
  mocks.routerPush.mockReset();
  mocks.apiCall.mockResolvedValue({});
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

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

function renderPreferencesShell() {
  return render(<ToastProvider><SettingsShell initialTab="preferences" renderTab={(id) => id === "preferences" ? <SettingsMisc /> : <p>panel {id}</p>} /></ToastProvider>);
}

function makePreferencesDirty(source: "preferences" | "notifications") {
  if (source === "preferences") fireEvent.change(screen.getByLabelText("Default tab"), { target: { value: "macro" } });
  else fireEvent.click(screen.getByRole("checkbox", { name: "New reviews" }));
}

function expectPreferencesDraft(source: "preferences" | "notifications") {
  if (source === "preferences") expect((screen.getByLabelText("Default tab") as HTMLSelectElement).value).toBe("macro");
  else expect((screen.getByRole("checkbox", { name: "New reviews" }) as HTMLInputElement).checked).toBe(false);
}

describe("Devices navigation from real Preferences forms", () => {
  it.each(["preferences", "notifications"] as const)("guards %s edits, keeps them on Stay, and routes only after explicit Discard", (source) => {
    mocks.ownerId = "synthetic-settings-owner";
    window.history.replaceState(null, "", "/settings?tab=misc&ref=devices#local-anchor");
    renderPreferencesShell();
    makePreferencesDirty(source);
    const devices = screen.getByRole("link", { name: "Devices" });
    expect(devices.getAttribute("href")).toBe("/devices");
    fireEvent.click(devices);
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    expect(mocks.routerPush).not.toHaveBeenCalled();
    expect(mocks.apiCall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stay on this tab" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expectPreferencesDraft(source);
    expect(window.location.search + window.location.hash).toBe("?tab=misc&ref=devices#local-anchor");
    fireEvent.click(devices);
    fireEvent.click(screen.getByRole("button", { name: "Discard & open Devices" }));
    expect(mocks.routerPush).toHaveBeenCalledTimes(1);
    expect(mocks.routerPush).toHaveBeenCalledWith("/devices");
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it.each(["preferences", "notifications"] as const)("leaves modified Devices clicks native while retaining %s edits", (source) => {
    mocks.ownerId = "synthetic-settings-owner";
    window.history.replaceState(null, "", "/settings?tab=preferences&ref=devices");
    renderPreferencesShell();
    makePreferencesDirty(source);
    const devices = screen.getByRole("link", { name: "Devices" });
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      let wasPrevented: boolean | undefined;
      const cancelJSDOMNavigation = (event: Event) => { wasPrevented = event.defaultPrevented; event.preventDefault(); };
      document.addEventListener("click", cancelJSDOMNavigation, { once: true });
      fireEvent.click(devices, modifier);
      expect(wasPrevented).toBe(false);
      expect(screen.queryByRole("dialog")).toBeNull();
      expectPreferencesDraft(source);
    }
    expect(mocks.routerPush).not.toHaveBeenCalled();
    expect(mocks.apiCall).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?tab=preferences&ref=devices");
  });

  it("keeps clean same-tab Devices navigation available without a dialog", () => {
    renderPreferencesShell();
    fireEvent.click(screen.getByRole("link", { name: "Devices" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.routerPush).toHaveBeenCalledTimes(1);
    expect(mocks.routerPush).toHaveBeenCalledWith("/devices");
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });
});

describe("SettingsMisc default tab", () => {
  it("keeps notification-only edits guarded after resetting the other Preferences form", () => {
    mocks.ownerId = "synthetic-settings-owner";
    render(<ToastProvider><SettingsShell initialTab="preferences" renderTab={(id) => id === "preferences" ? <SettingsMisc /> : <p>panel {id}</p>} /></ToastProvider>);
    const notifications = screen.getByRole("checkbox", { name: "New reviews" });
    fireEvent.click(notifications);
    fireEvent.change(screen.getByLabelText("Default tab"), { target: { value: "macro" } });
    fireEvent.click(within(screen.getByRole("region", { name: "Unsaved changes" })).getByRole("button", { name: "Discard" }));
    expect(screen.getAllByRole("img", { name: "Unsaved changes" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("tab", { name: "Profile" })[0]);
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stay on this tab" }));
    expect((notifications as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^Reset$/ }));
    expect(screen.queryAllByRole("img", { name: "Unsaved changes" })).toHaveLength(0);
    fireEvent.click(screen.getAllByRole("tab", { name: "Profile" })[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("tabpanel").textContent).toBe("panel profile");
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("publishes real draft edits under Preferences and guards leaving without saving", () => {
    window.history.replaceState(null, "", "/settings?tab=misc");
    render(<ToastProvider><SettingsShell initialTab="preferences" renderTab={(id) => id === "preferences" ? <SettingsMisc /> : <p>panel {id}</p>} /></ToastProvider>);
    fireEvent.change(screen.getByLabelText("Default tab"), { target: { value: "macro" } });
    expect(screen.getAllByRole("img", { name: "Unsaved changes" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("tab", { name: "Profile" })[0]);
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stay on this tab" }));
    expect((screen.getByLabelText("Default tab") as HTMLSelectElement).value).toBe("macro");
    expect(mocks.apiCall).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("tab", { name: "Profile" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Discard & switch" }));
    expect(screen.getByRole("tabpanel").textContent).toBe("panel profile");
    expect(screen.queryAllByRole("img", { name: "Unsaved changes" })).toHaveLength(0);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

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
