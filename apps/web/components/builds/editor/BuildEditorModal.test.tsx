import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "token"),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken }),
}));
vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => harness.apiCall(...args),
  useApi: () => ({ data: undefined, error: undefined, isLoading: false }),
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: harness.toast }),
  useToastOptional: () => ({ toast: harness.toast }),
}));

import { BuildEditorModal } from "./BuildEditorModal";

afterEach(() => {
  cleanup();
  harness.apiCall.mockReset();
});

function renderEditor(props: Partial<ComponentProps<typeof BuildEditorModal>> = {}) {
  return render(
    <BuildEditorModal
      open
      onClose={vi.fn()}
      events={[{ time: 20, name: "Gateway", is_building: true }]}
      race="Zerg"
      vsRace="Protoss"
      perspective="opponent"
      defaultName="Zerg build vs Protoss"
      {...props}
    />,
  );
}

function basics() {
  return screen.getByRole("region", { name: "Basics" });
}

describe("BuildEditorModal matchup lock", () => {
  it("keeps race and vs race editable by default", () => {
    renderEditor();
    const section = basics();
    const race = within(section).getByLabelText("Race") as HTMLSelectElement;
    expect(race.tagName).toBe("SELECT");
    expect(Array.from(race.options).map((option) => option.value)).toEqual([
      "Protoss",
      "Terran",
      "Zerg",
      "Random",
    ]);
    const vsRace = within(section).getByLabelText("Vs race") as HTMLSelectElement;
    expect(Array.from(vsRace.options).map((option) => option.value)).toEqual([
      "Protoss",
      "Terran",
      "Zerg",
      "Random",
      "Any",
    ]);
  });

  it("shows the game's race read-only and only its opponent race or Any", () => {
    renderEditor({ lockMatchup: true });
    const section = basics();
    const race = within(section).getByLabelText("Race") as HTMLInputElement;
    expect(race.tagName).toBe("INPUT");
    expect(race.readOnly).toBe(true);
    expect(race.value).toBe("Zerg");
    expect(within(section).getByText("Set by this game.")).toBeTruthy();
    const vsRace = within(section).getByLabelText("Vs race") as HTMLSelectElement;
    expect(Array.from(vsRace.options).map((option) => option.value)).toEqual([
      "Protoss",
      "Any",
    ]);
    expect(vsRace.value).toBe("Protoss");
    expect(within(section).getByText("Only Protoss or Any fits this game.")).toBeTruthy();
    expect(
      (within(section).getByLabelText(/^Name/) as HTMLInputElement).value,
    ).toBe("Zerg build vs Protoss");
  });

  it("saves create-only with the locked matchup and shows a taken name on the field", async () => {
    harness.apiCall.mockRejectedValueOnce({
      status: 409,
      code: "slug_taken",
      message: "slug_taken",
    });
    const onSaved = vi.fn();
    renderEditor({ lockMatchup: true, createOnly: true, gameId: "g1", onSaved });
    fireEvent.change(screen.getByLabelText("Vs race"), { target: { value: "Any" } });
    fireEvent.click(screen.getAllByRole("button", { name: /^Add rule: / })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save build" }));

    await waitFor(() => expect(harness.apiCall).toHaveBeenCalled());
    const saveCall = harness.apiCall.mock.calls.find(
      (call) => (call[2] as RequestInit | undefined)?.method === "PUT",
    )!;
    expect(saveCall[1]).toBe("/v1/custom-builds/zerg-build-vs-protoss");
    expect(JSON.parse(String((saveCall[2] as RequestInit).body))).toMatchObject({
      race: "Zerg",
      vsRace: "Any",
      perspective: "opponent",
      sourceGameId: "g1",
      createOnly: true,
    });
    expect(
      (await within(basics()).findByRole("alert")).textContent,
    ).toBe("You already have a build called that — pick another name");
    expect(onSaved).not.toHaveBeenCalled();
  });
});
