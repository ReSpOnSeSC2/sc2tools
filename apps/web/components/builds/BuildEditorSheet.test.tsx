import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "test-token"),
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
}));

vi.mock("@/lib/useMyDisplayName", () => ({
  useMyDisplayName: () => "",
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: harness.toast }),
}));

import { BuildEditorSheet } from "./BuildEditorSheet";

beforeEach(() => {
  harness.apiCall.mockReset();
  harness.apiCall.mockResolvedValue({ community: null });
  harness.getToken.mockClear();
});

afterEach(cleanup);

describe("BuildEditorSheet proxy requirements", () => {
  it("exposes the proxy option and persists it on a building signature", async () => {
    const onSaved = vi.fn();
    render(
      <BuildEditorSheet
        open
        onClose={vi.fn()}
        build={null}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: /^Name/ }), {
      target: { value: "Proxy Barracks" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));

    const emptyProxy = screen.getByRole("checkbox", {
      name: "Only count proxied buildings",
    }) as HTMLInputElement;
    expect(emptyProxy.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Step unit"), {
      target: { value: "Barracks" },
    });
    const proxy = screen.getByRole("checkbox", {
      name: "Only count proxied Barracks",
    }) as HTMLInputElement;
    expect(proxy.disabled).toBe(false);
    expect(proxy.closest("label")?.getAttribute("title")).toMatch(
      /^Only count this structure when placed more than 50 world units/,
    );
    fireEvent.click(proxy);

    fireEvent.click(screen.getByRole("button", { name: "Create build" }));

    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(1));
    const request = harness.apiCall.mock.calls[0]?.[2] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      signature: [{
        unit: "Barracks",
        count: 1,
        beforeSec: 60,
        proxy: true,
      }],
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
      signature: [expect.objectContaining({ proxy: true })],
    }));
  });

  it("restores a saved proxy requirement when editing", () => {
    render(
      <BuildEditorSheet
        open
        onClose={vi.fn()}
        build={{
          slug: "proxy-gateway",
          name: "Proxy Gateway",
          race: "Protoss",
          signature: [{
            unit: "Gateway",
            count: 1,
            beforeSec: 90,
            proxy: true,
          }],
        }}
        onSaved={vi.fn()}
      />,
    );

    expect((screen.getByRole("checkbox", {
      name: "Only count proxied Gateway",
    }) as HTMLInputElement).checked).toBe(true);
  });

  it("blocks an invalid proxy target instead of silently saving it normally", async () => {
    render(
      <BuildEditorSheet
        open
        onClose={vi.fn()}
        build={null}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: /^Name/ }), {
      target: { value: "Invalid proxy target" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.change(screen.getByLabelText("Step unit"), {
      target: { value: "Barracks" },
    });
    fireEvent.click(screen.getByRole("checkbox", {
      name: "Only count proxied Barracks",
    }));
    fireEvent.change(screen.getByLabelText("Step unit"), {
      target: { value: "Marine" },
    });

    const form = screen.getByRole("dialog").querySelector("form");
    fireEvent.submit(form as HTMLFormElement);

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Only count proxied” needs a known building/,
    );
    expect(harness.apiCall).not.toHaveBeenCalled();
  });
});

describe("BuildEditorSheet step wording", () => {
  it("reads each step as at least that many started before its time", () => {
    render(
      <BuildEditorSheet
        open
        onClose={vi.fn()}
        build={null}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText(
      "Each step means at least that many started before its time.",
    )).toBeTruthy();
    expect(screen.getByText(/No steps yet\./).textContent).toContain(
      "2:30 Stargate means at least 1 Stargate started before 2:30",
    );

    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    expect(screen.getByRole("textbox", {
      name: "Started before (game time)",
    })).toBeTruthy();
    expect(screen.getByRole("spinbutton", {
      name: "At least how many",
    })).toBeTruthy();
    expect(screen.getByLabelText("Step unit")).toBeTruthy();
    expect(screen.getByText("Only count proxied")).toBeTruthy();
  });
});
