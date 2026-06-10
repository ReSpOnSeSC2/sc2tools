import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Export wiring test: the optimizer's "save to my builds" flow must
 * hit the same PUT /v1/custom-builds/:slug path manual builds use,
 * with an API-schema-valid payload. Clerk and the API client are
 * mocked; the OptimizeResult is produced by the real engine.
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
import { resolveProfile } from "@/lib/optimizer/patch/profiles";
import { evaluateCandidate } from "@/lib/optimizer/search/optimize";
import { defaultPolicies } from "@/lib/optimizer/sim/engine";
import { threatCatalog } from "@/lib/optimizer/threats/store";
import type { BuildAction, OptimizeResult } from "@/lib/optimizer/types";
import { ExportToBuildsButton } from "../optimizer/ExportToBuildsButton";

afterEach(() => {
  cleanup();
  apiCallMock.mockReset();
});

function makeResult(): OptimizeResult {
  const profile = resolveProfile("5.0.16");
  const eightPool = threatCatalog(null).find((t) => t.id === "z-8pool")!;
  const actions: BuildAction[] = [
    { kind: "build", name: "Pylon" },
    { kind: "build", name: "Gateway" },
    { kind: "train", name: "Zealot" },
    { kind: "build", name: "Nexus" },
  ];
  const candidate = evaluateCandidate(actions, profile, {
    profileId: "5.0.16",
    race: "Protoss",
    vsRace: "Zerg",
    objective: { id: "earliest-safe-expansion", atSec: 360 },
    threats: [{ threat: eightPool, probability: 0.8 }],
    policies: defaultPolicies(),
    safety: { hasWall: true, allowWorkerPull: true },
    seed: 1,
    budget: { maxGenerations: 1, maxMillis: 1000 },
    horizonSec: 300,
  });
  return {
    actions,
    sim: candidate.sim,
    safety: candidate.safety,
    score: candidate.score,
    generations: 1,
    evaluations: 1,
    seed: 1,
    objective: { id: "earliest-safe-expansion", atSec: 360 },
    profileId: "5.0.16",
  };
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
      target: { value: "PvZ safe expand vs 8-pool" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save build$/i }));

    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1));
    const [, path, init] = apiCallMock.mock.calls[0] as [
      unknown,
      string,
      { method: string; body: string },
    ];
    expect(path).toBe("/v1/custom-builds/pvz-safe-expand-vs-8-pool");
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
