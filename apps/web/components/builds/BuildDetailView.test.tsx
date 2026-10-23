import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomBuild } from "./types";

const harness = vi.hoisted(() => ({
  build: null as CustomBuild | null,
  error: null as { status: number; message: string; requestId?: string } | null,
  mutate: vi.fn(async () => undefined),
  apiCall: vi.fn(async () => null),
  push: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn(async () => "test-token") }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: harness.push }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
  useApi: () => ({
    data: harness.build ?? undefined,
    error: harness.error,
    mutate: harness.mutate,
  }),
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({
    toast: { success: harness.toastSuccess, error: vi.fn() },
  }),
}));

vi.mock("./BuildDossier", () => ({ BuildDossier: () => null }));
vi.mock("./BuildPublishModal", () => ({ BuildPublishModal: () => null }));
vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? <button onClick={onConfirm}>Confirm delete</button> : null,
}));
vi.mock("./BuildEditorSheet", () => ({
  BuildEditorSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="signature-editor" /> : null,
}));
vi.mock("./EditCustomBuildLauncher", () => ({
  EditCustomBuildLauncher: ({ build }: { build: CustomBuild | null }) =>
    build ? <div data-testid="rules-editor" /> : null,
}));

import { BuildDetailView, buildDocumentTitle } from "./BuildDetailView";

const RULE_BUILD: CustomBuild = {
  slug: "proxy-gateway",
  name: "Proxy Gateway",
  race: "Protoss",
  rules: [
    { type: "before", name: "BuildGateway", time_lt: 100, proxy: true },
    { type: "count_max", name: "BuildNexus", count: 0, time_lt: 240 },
  ],
};

afterEach(() => {
  cleanup();
  harness.build = null;
  harness.error = null;
  harness.mutate.mockClear();
  harness.apiCall.mockClear();
  harness.push.mockClear();
  harness.toastSuccess.mockClear();
  vi.restoreAllMocks();
});

describe("BuildDetailView editor routing", () => {
  it("opens v3 rule builds in the rich rule editor", () => {
    harness.build = RULE_BUILD;

    render(<BuildDetailView slug={RULE_BUILD.slug} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByTestId("rules-editor")).toBeTruthy();
    expect(screen.queryByTestId("signature-editor")).toBeNull();
  });

  it("keeps signature-only builds in the manual step editor", () => {
    harness.build = {
      slug: "legacy-pool",
      name: "Legacy Pool",
      race: "Zerg",
      signature: [{ unit: "spawningpool", count: 1, beforeSec: 90 }],
    };

    render(<BuildDetailView slug={harness.build.slug} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByTestId("signature-editor")).toBeTruthy();
    expect(screen.queryByTestId("rules-editor")).toBeNull();
  });
});

describe("BuildDetailView states", () => {
  it("a failed load (not a 404) shows the error card, and Retry calls mutate", async () => {
    harness.error = { status: 500, message: "The server had a problem.", requestId: "req-fixture-1" };

    render(<BuildDetailView slug="proxy-gateway" />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn’t load this build");
    expect(alert.textContent).toContain("The server had a problem.");
    expect(alert.textContent).toContain("req-fixture-1");
    expect(screen.queryByText("Build not found")).toBeNull();
    const backLinks = screen.getAllByRole("link", { name: /Back to library/ });
    expect(backLinks.every((link) => link.getAttribute("href") === "/builds")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(harness.mutate).toHaveBeenCalledTimes(1));
  });

  it("a 404 still says the build wasn't found", () => {
    harness.error = { status: 404, message: "Not found" };
    render(<BuildDetailView slug="gone" />);
    expect(screen.getByText("Build not found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("names the tab after the build once it loads", () => {
    harness.build = RULE_BUILD;
    render(<BuildDetailView slug={RULE_BUILD.slug} />);
    expect(document.title).toBe(buildDocumentTitle("Proxy Gateway"));
    expect(document.title).toBe("Proxy Gateway · Custom build · SC2 Tools");
  });

  it("reads rule builds back as Must have / Must not have", () => {
    harness.build = RULE_BUILD;
    render(<BuildDetailView slug={RULE_BUILD.slug} />);
    expect(screen.getByRole("heading", { name: "Must have" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Must not have" })).toBeTruthy();
    expect(screen.getByText("Proxy")).toBeTruthy();
  });

  it("after a delete, navigates with the router so the toast survives", async () => {
    harness.build = RULE_BUILD;
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign,
    } as Location);

    render(<BuildDetailView slug={RULE_BUILD.slug} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => expect(harness.push).toHaveBeenCalledWith("/builds"));
    expect(harness.apiCall).toHaveBeenCalledWith(
      expect.any(Function),
      "/v1/custom-builds/proxy-gateway",
      { method: "DELETE" },
    );
    expect(harness.toastSuccess).toHaveBeenCalledWith("Build deleted.");
    expect(assign).not.toHaveBeenCalled();
  });
});
