import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  me: null as { isAdmin?: boolean } | null,
  user: null as null | {
    id: string;
    createdAt: Date;
    externalAccounts: Array<{ provider: string }>;
  },
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: () => ({ data: mocks.me }),
}));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ isLoaded: true, user: mocks.user }),
}));

import { InternalTrafficMarker, SignUpTracker } from "@/components/analytics/AnalyticsSignals";
import { INTERNAL_TRAFFIC_STORAGE_KEY } from "@/lib/analytics/internalTraffic";

describe("InternalTrafficMarker", () => {
  const gtag = vi.fn();

  beforeEach(() => {
    window.gtag = gtag;
  });

  afterEach(() => {
    cleanup();
    gtag.mockReset();
    delete window.gtag;
    window.localStorage.clear();
    mocks.me = null;
  });

  it("flags an admin's browser and tags the running session", () => {
    mocks.me = { isAdmin: true };
    render(<InternalTrafficMarker />);
    expect(window.localStorage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY)).toBe("1");
    expect(gtag).toHaveBeenCalledWith("set", { traffic_type: "internal" });
  });

  it("leaves everyone else's browser alone", () => {
    mocks.me = { isAdmin: false };
    render(<InternalTrafficMarker />);
    expect(window.localStorage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY)).toBeNull();
    expect(gtag).not.toHaveBeenCalled();
  });
});

describe("SignUpTracker", () => {
  const gtag = vi.fn();

  beforeEach(() => {
    window.gtag = gtag;
  });

  afterEach(() => {
    cleanup();
    gtag.mockReset();
    delete window.gtag;
    window.localStorage.clear();
    mocks.user = null;
  });

  it("sends sign_up once for a brand-new account", () => {
    mocks.user = { id: "user_1", createdAt: new Date(Date.now() - 60_000), externalAccounts: [{ provider: "google" }] };
    render(<SignUpTracker />);
    expect(gtag).toHaveBeenCalledWith("event", "sign_up", { method: "google" });
    cleanup();
    render(<SignUpTracker />);
    expect(gtag).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for an established account", () => {
    mocks.user = { id: "user_2", createdAt: new Date("2026-01-01T00:00:00Z"), externalAccounts: [] };
    render(<SignUpTracker />);
    expect(gtag).not.toHaveBeenCalled();
  });

  it("waits for gtag.js instead of losing the event", () => {
    delete window.gtag;
    mocks.user = { id: "user_3", createdAt: new Date(Date.now() - 60_000), externalAccounts: [] };
    render(<SignUpTracker />);
    expect(window.localStorage.getItem("sc2tools.signUpTracked.v1")).toBeNull();
  });
});
