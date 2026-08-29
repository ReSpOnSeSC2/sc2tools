import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomBuild } from "./types";

const harness = vi.hoisted(() => ({
  build: null as CustomBuild | null,
  mutate: vi.fn(async () => undefined),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn(async () => "test-token") }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: vi.fn(),
  useApi: () => ({
    data: harness.build,
    error: null,
    mutate: harness.mutate,
  }),
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({
    toast: { success: vi.fn(), error: vi.fn() },
  }),
}));

vi.mock("./BuildDossier", () => ({ BuildDossier: () => null }));
vi.mock("./BuildPublishModal", () => ({ BuildPublishModal: () => null }));
vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));
vi.mock("./BuildEditorSheet", () => ({
  BuildEditorSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="signature-editor" /> : null,
}));
vi.mock("./EditCustomBuildLauncher", () => ({
  EditCustomBuildLauncher: ({ build }: { build: CustomBuild | null }) =>
    build ? <div data-testid="rules-editor" /> : null,
}));

import { BuildDetailView } from "./BuildDetailView";

afterEach(() => {
  cleanup();
  harness.build = null;
  harness.mutate.mockClear();
});

describe("BuildDetailView editor routing", () => {
  it("opens v3 rule builds in the rich rule editor", () => {
    harness.build = {
      slug: "proxy-gateway",
      name: "Proxy Gateway",
      race: "Protoss",
      rules: [{
        type: "before",
        name: "BuildGateway",
        time_lt: 100,
        proxy: true,
      }],
    };

    render(<BuildDetailView slug={harness.build.slug} />);
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
