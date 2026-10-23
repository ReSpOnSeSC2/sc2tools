import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomBuild } from "@/components/builds/types";

/**
 * "Save to my library" on a community build: signed-out visitors get a
 * sign-up link that comes back here, signed-in users never save a second
 * copy by accident (an existing copy, found by forkedFrom.communitySlug,
 * shows "In your library — Open"), and a save records the provenance.
 * All data is synthetic test fixture data.
 */
const harness = vi.hoisted(() => ({
  signedIn: true,
  lookup: { items: [] } as {
    items: Array<{ slug: string; forkedFrom?: { communitySlug: string } }>;
  } | undefined,
  lookupPaths: [] as Array<string | null>,
  mutate: vi.fn(),
  apiCall: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  SignedIn: ({ children }: { children: ReactNode }) => (harness.signedIn ? <>{children}</> : null),
  SignedOut: ({ children }: { children: ReactNode }) => (harness.signedIn ? null : <>{children}</>),
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
  useApi: (path: string | null) => {
    harness.lookupPaths.push(path);
    return { data: harness.lookup, error: undefined, mutate: harness.mutate };
  },
}));

vi.mock("@/components/ui/Toast", () => ({
  useToastOptional: () => ({ toast: { success: harness.toastSuccess } }),
}));

import { SaveToLibraryButton, forkLookupPath } from "../SaveToLibraryButton";

const SNAPSHOT: Partial<CustomBuild> & Record<string, unknown> = {
  name: "PvZ - Stargate into Glaives",
  race: "Protoss",
  vsRace: "Zerg",
  description: "Oracle into Glaive Adepts.",
  rules: [
    { type: "before", name: "BuildStargate", time_lt: 240 },
    { type: "count_max", name: "BuildRoboticsFacility", count: 0, time_lt: 360 },
  ],
  skillLevel: "diamond",
  winConditions: ["Kill the third"],
};

function renderButton() {
  return render(
    <SaveToLibraryButton
      build={SNAPSHOT}
      title="Glaive Adepts off a Stargate"
      communitySlug="glaives-fixture01"
      version="2026-09-01T12:00:00.000Z"
    />,
  );
}

/** Every PUT /v1/custom-builds/... call made so far. */
function saves() {
  return harness.apiCall.mock.calls.filter(
    ([, , init]) => (init as RequestInit | undefined)?.method === "PUT",
  );
}

beforeEach(() => {
  harness.signedIn = true;
  harness.lookup = { items: [] };
  harness.lookupPaths.length = 0;
  harness.apiCall.mockReset();
  harness.mutate.mockReset();
  harness.toastSuccess.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SaveToLibraryButton", () => {
  it("offers signed-out visitors a sign-up that returns to this build", () => {
    harness.signedIn = false;
    renderButton();
    const signUp = screen.getByRole("link", { name: "Sign up free to save this build" });
    expect(signUp.getAttribute("href")).toBe(
      "/sign-up?redirect_url=%2Fcommunity%2Fbuilds%2Fglaives-fixture01",
    );
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/sign-in?redirect_url=%2Fcommunity%2Fbuilds%2Fglaives-fixture01",
    );
    expect(screen.queryByRole("button", { name: /Save to my library/ })).toBeNull();
    expect(harness.lookupPaths).toEqual([]);
  });

  it("looks up an existing copy by its community slug", () => {
    renderButton();
    expect(harness.lookupPaths[0]).toBe(forkLookupPath("glaives-fixture01"));
    expect(forkLookupPath("glaives-fixture01")).toBe(
      "/v1/custom-builds?forkedFrom=glaives-fixture01&limit=1&view=summary",
    );
  });

  it("shows 'In your library — Open' when a copy already exists, with a client link", () => {
    harness.lookup = { items: [{ slug: "glaive-adepts-abc", forkedFrom: { communitySlug: "glaives-fixture01" } }] };
    renderButton();
    const open = screen.getByRole("link", { name: /In your library — Open/ });
    expect(open.getAttribute("href")).toBe("/builds/glaive-adepts-abc");
    expect(screen.queryByRole("button", { name: /Save to my library/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Save another copy/ })).toBeTruthy();
  });

  it("a click when a copy exists elsewhere shows 'In your library' and does not save", async () => {
    // The page loaded before the copy existed (another tab saved it).
    harness.apiCall.mockImplementation(async (_token: unknown, path: string) => {
      if (path.startsWith("/v1/custom-builds?")) return { items: [{ slug: "saved-in-other-tab", forkedFrom: { communitySlug: "glaives-fixture01" } }] };
      throw new Error(`unexpected call ${path}`);
    });
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: /Save to my library/ }));
    const open = await screen.findByRole("link", { name: /In your library — Open/ });
    expect(open.getAttribute("href")).toBe("/builds/saved-in-other-tab");
    expect(saves()).toHaveLength(0);
  });

  it("saves a private copy with its provenance, then shows it and a toast", async () => {
    harness.apiCall.mockImplementation(async (_token: unknown, path: string) => {
      if (path.startsWith("/v1/custom-builds?")) return { items: [] };
      return { ok: true, saved: true };
    });
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: /Save to my library/ }));
    const open = await screen.findByRole("link", { name: /In your library — Open/ });

    expect(saves()).toHaveLength(1);
    const [, path, init] = saves()[0] as [unknown, string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(path).toBe(`/v1/custom-builds/${body.slug}`);
    expect(open.getAttribute("href")).toBe(`/builds/${body.slug}`);
    expect(body).toMatchObject({
      name: "Glaive Adepts off a Stargate",
      race: "Protoss",
      vsRace: "Zerg",
      createOnly: true,
      skillLevel: "diamond",
      winConditions: ["Kill the third"],
      schemaVersion: 3,
      forkedFrom: {
        communitySlug: "glaives-fixture01",
        version: "2026-09-01T12:00:00.000Z",
      },
    });
    expect(body.rules).toHaveLength(2);
    expect(Number.isNaN(Date.parse(body.forkedFrom.savedAt))).toBe(false);
    expect(harness.toastSuccess).toHaveBeenCalledWith(
      "Saved to your library",
      expect.objectContaining({ description: expect.anything() }),
    );
    expect(harness.mutate).toHaveBeenCalled();
  });

  it("'Save another copy' saves again on purpose", async () => {
    harness.lookup = { items: [{ slug: "first-copy", forkedFrom: { communitySlug: "glaives-fixture01" } }] };
    harness.apiCall.mockResolvedValue({ ok: true, saved: true });
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: /Save another copy/ }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    const body = JSON.parse(String((saves()[0][2] as RequestInit).body));
    expect(body.forkedFrom.communitySlug).toBe("glaives-fixture01");
    expect(body.slug).not.toBe("first-copy");
  });

  it("shows the API's message when the save fails", async () => {
    harness.apiCall.mockImplementation(async (_token: unknown, path: string) => {
      if (path.startsWith("/v1/custom-builds?")) return { items: [] };
      throw { status: 500, message: "The server had a problem." };
    });
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: /Save to my library/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("The server had a problem.");
    expect(screen.getByRole("button", { name: /Save to my library/ })).toBeTruthy();
  });

  it("does not trust unrelated rows from an API that ignores forkedFrom", async () => {
    harness.lookup = { items: [{ slug: "unrelated-build" }] };
    harness.apiCall.mockImplementation(async (_token: unknown, path: string) => {
      if (path.startsWith("/v1/custom-builds?")) {
        return { items: [{ slug: "another-build", forkedFrom: { communitySlug: "another-community-build" } }] };
      }
      return { ok: true };
    });
    renderButton();
    expect(screen.queryByRole("link", { name: /In your library/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Save to my library/ }));
    const open = await screen.findByRole("link", { name: /In your library/ });
    expect(saves()).toHaveLength(1);
    expect(open.getAttribute("href")).not.toMatch(/unrelated-build|another-build/);
  });

  it("keeps a unique suffix for long titles even when two copies save at the same time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 22, 12));
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    harness.apiCall.mockImplementation(async (_token: unknown, path: string) =>
      path.startsWith("/v1/custom-builds?") ? { items: [] } : { ok: true });
    render(<SaveToLibraryButton build={SNAPSHOT}
      title="PvZ - Stargate Oracle into Glaive Adepts with a fast third Nexus and Robo for Disruptors"
      communitySlug="glaives-fixture01" />);
    fireEvent.click(screen.getByRole("button", { name: /Save to my library/ }));
    const another = await screen.findByRole("button", { name: "Save another copy" });
    fireEvent.click(another);
    await waitFor(() => expect(saves()).toHaveLength(2));
    const slugs = saves().map(([, , init]) => JSON.parse(String((init as RequestInit).body)).slug as string);
    expect(slugs[0]).not.toBe(slugs[1]);
    expect(slugs[0]).toMatch(/-11111111$/);
    expect(slugs[1]).toMatch(/-22222222$/);
    expect(slugs.every((slug) => slug.length === 80)).toBe(true);
  });

  it("explains a build that predates library saving", () => {
    render(<SaveToLibraryButton build={undefined} title="Old" communitySlug="old-build" />);
    expect(screen.getByText(/predates library saving/)).toBeTruthy();
  });
});
