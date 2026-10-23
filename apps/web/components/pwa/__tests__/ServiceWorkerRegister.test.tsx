/**
 * ServiceWorkerRegister — the root-layout blast radius.
 *
 * This component mounts inside the ROOT layout, above app/error.tsx.
 * Anything it throws therefore lands in global-error.tsx and replaces
 * the whole document with "SC2 Tools hit a critical error" — so the
 * bar here is not "does registration work", it is "can this component
 * ever take the page down". The opaque-origin case below did exactly
 * that to the Settings scene preview, which frames an overlay route.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const pathname = vi.hoisted(() => ({ current: "/app" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

import { ServiceWorkerRegister, UPDATE_LATER_KEY } from "../ServiceWorkerRegister";

/** What Chrome does inside sandbox="allow-scripts" (no same-origin). */
function makeContainerThrow() {
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    get() {
      throw new DOMException(
        "Failed to read the 'serviceWorker' property from 'Navigator': " +
          "Service worker is disabled because the context is sandboxed and " +
          "lacks the 'allow-same-origin' flag.",
        "SecurityError",
      );
    },
  });
}

function installStubContainer() {
  const register = vi.fn().mockResolvedValue({
    waiting: null,
    installing: null,
    addEventListener: vi.fn(),
    update: vi.fn(),
  });
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: {
      register,
      controller: null,
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  return register;
}

/** A registration with a new build's worker already waiting (an update). */
function installWaitingWorker() {
  const waiting = { postMessage: vi.fn() };
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn().mockResolvedValue({
        waiting,
        installing: null,
        addEventListener: vi.fn(),
        update: vi.fn(),
      }),
      controller: {},
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  return waiting;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  pathname.current = "/app";
  delete (window.navigator as { serviceWorker?: unknown }).serviceWorker;
});

describe("opaque origin (sandboxed iframe)", () => {
  it("does not throw when reading navigator.serviceWorker throws", () => {
    makeContainerThrow();
    expect(() => render(<ServiceWorkerRegister />)).not.toThrow();
  });

  it("cannot rely on the `in` check to detect this", () => {
    // Documents WHY the guard needs a try/catch: the property is on
    // Navigator.prototype, so the feature test passes and only the
    // read throws. Someone "simplifying" this back to `in` should see
    // this fail.
    makeContainerThrow();
    expect("serviceWorker" in window.navigator).toBe(true);
    expect(() => window.navigator.serviceWorker).toThrow();
  });
});

describe("overlay routes", () => {
  it("registers no worker on an overlay route", () => {
    // OBS Browser Sources get nothing from an app-shell cache, and a
    // stale shell is what the overlay's no-store headers exist to
    // prevent.
    pathname.current = "/overlay/tok/scene/intermission";
    const register = installStubContainer();
    render(<ServiceWorkerRegister />);
    expect(register).not.toHaveBeenCalled();
  });

  it("still registers on a normal app route", () => {
    pathname.current = "/app";
    const register = installStubContainer();
    render(<ServiceWorkerRegister />);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });
});

describe("update prompt", () => {
  const prompt = () => screen.queryByRole("status", { name: "Update available" });

  it("floats above the mobile tab bar on the banner layer", async () => {
    installWaitingWorker();
    render(<ServiceWorkerRegister />);
    const shown = await screen.findByRole("status", { name: "Update available" });
    expect(shown.className).toContain("bottom-above-chrome");
    expect(shown.className).toContain("z-banner");
  });

  it("Reload hands control to the waiting worker", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const waiting = installWaitingWorker();
      render(<ServiceWorkerRegister />);
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
      expect(screen.getByRole("button", { name: "Updating…" })).toBeTruthy();
    } finally {
      // Drop the 3 s reload fallback without running it.
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("'Later' hides the prompt for the session and leaves the worker waiting", async () => {
    const waiting = installWaitingWorker();
    const view = render(<ServiceWorkerRegister />);
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(prompt()).toBeNull();
    expect(waiting.postMessage).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(UPDATE_LATER_KEY)).toBe("1");

    // Moving between the app and the public pages remounts it: still hidden.
    view.unmount();
    render(<ServiceWorkerRegister />);
    await act(async () => {});
    expect(prompt()).toBeNull();
  });

  it("comes back in the next session while the update is still waiting", async () => {
    installWaitingWorker();
    window.sessionStorage.setItem(UPDATE_LATER_KEY, "1");
    const view = render(<ServiceWorkerRegister />);
    await act(async () => {});
    expect(prompt()).toBeNull();
    view.unmount();

    window.sessionStorage.clear(); // a new tab or browser session
    render(<ServiceWorkerRegister />);
    expect(await screen.findByRole("status", { name: "Update available" })).toBeTruthy();
  });

  it("still works when session storage is blocked", async () => {
    installWaitingWorker();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    render(<ServiceWorkerRegister />);
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(prompt()).toBeNull();
  });
});
