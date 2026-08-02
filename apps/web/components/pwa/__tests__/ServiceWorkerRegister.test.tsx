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
import { cleanup, render } from "@testing-library/react";

const pathname = vi.hoisted(() => ({ current: "/app" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

import { ServiceWorkerRegister } from "../ServiceWorkerRegister";

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

afterEach(() => {
  cleanup();
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
