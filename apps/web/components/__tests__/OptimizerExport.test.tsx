import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Export wiring test: the build adapter's "save to my builds" flow
 * must hit the same PUT /v1/custom-builds/:slug path manual builds
 * use, with an API-schema-valid payload. Clerk and the API client are
 * mocked; the AdaptResult comes from the real engine.
 */

const apiCallMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => apiCallMock(...args),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
  SignedIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedOut: () => null,
  SignInButton: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ToastProvider } from "@/components/ui/Toast";
import {
  actionsFromSteps,
  adaptBuild,
  referenceBuilds,
} from "@/lib/optimizer/adapt/adapt";
import { resolveProfile } from "@/lib/optimizer/patch/profiles";
import { defaultPolicies } from "@/lib/optimizer/sim/engine";
import { threatCatalog } from "@/lib/optimizer/threats/store";
import type { AdaptResult } from "@/lib/optimizer/types";
import { ExportToBuildsButton } from "../optimizer/ExportToBuildsButton";

afterEach(() => {
  cleanup();
  apiCallMock.mockReset();
});

function makeResult(): AdaptResult {
  const profile = resolveProfile("5.0.16");
  const eightPool = threatCatalog(null).find((t) => t.id === "z-8pool")!;
  const reference = referenceBuilds().find((b) => b.id === "p-gate-expand")!;
  const { actions } = actionsFromSteps(profile, reference.steps);
  return adaptBuild({
    baselineProfileId: "lotv-base",
    profileId: "5.0.16",
    race: "Protoss",
    actions,
    referenceName: reference.name,
    referenceId: reference.id,
    threats: [{ threat: eightPool, probability: 0.8 }],
    policies: defaultPolicies(),
    safety: { hasWall: true, allowWorkerPull: true },
    horizonSec: 480,
  });
}

describe("ExportToBuildsButton", () => {
  it("PUTs an API-valid payload to /v1/custom-builds/:slug", async () => {
    apiCallMock.mockResolvedValue(undefined);
    render(
      <ToastProvider>
        <ExportToBuildsButton result={makeResult()} vsRace="Zerg" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /save to my builds/i }));
    const nameInput = await screen.findByLabelText(/name/i);
    fireEvent.change(nameInput, {
      target: { value: "PvZ gate expand re-timed" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save build$/i }));

    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1));
    const [, path, init] = apiCallMock.mock.calls[0] as [
      unknown,
      string,
      { method: string; body: string },
    ];
    expect(path).toBe("/v1/custom-builds/pvz-gate-expand-re-timed");
    expect(init.method).toBe("PUT");
    const payload = JSON.parse(init.body) as {
      slug: string;
      name: string;
      race: string;
      vsRace: string;
      perspective: string;
      signature: { unit: string; count: number; beforeSec: number }[];
      notes: string;
    };
    expect(payload.slug).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(payload.race).toBe("Protoss");
    expect(payload.vsRace).toBe("Zerg");
    expect(payload.perspective).toBe("you");
    expect(payload.signature.length).toBeGreaterThan(0);
    expect(payload.notes).toContain("Build order:");
    expect(payload.notes).toContain("Timing shifts");
  });

  it("renders nothing without a result", () => {
    const { container } = render(
      <ToastProvider>
        <ExportToBuildsButton result={null} vsRace="Zerg" />
      </ToastProvider>,
    );
    expect(container.textContent).toBe("");
  });
});
