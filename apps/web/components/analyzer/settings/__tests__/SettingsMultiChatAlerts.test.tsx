import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsMultiChatAlerts } from "../SettingsMultiChatAlerts";
import {
  DEFAULT_ALERTS,
  type AlertConfig,
} from "@/lib/multichat/alerts";
import { CHAT_EVENT_KINDS, EVENT_KIND_LABEL } from "@/lib/multichat/events";

// The component probes /v1/me to decide whether admin-only presets appear, and
// useApi reaches for Clerk's useAuth -- which throws outside <ClerkProvider>.
// Mocking the module boundary keeps this a unit test of the picker. Returning
// no data means "not an admin", so the SC2 3D presets stay hidden here; the
// admin case is covered in the mediaBase and ChatAlertCard suites.
vi.mock("@/lib/clientApi", () => ({
  API_BASE: "",
  useApi: () => ({ data: undefined, error: undefined, isLoading: false }),
}));

afterEach(cleanup);

function Harness({ spy = vi.fn() }: { spy?: (next: AlertConfig) => void }) {
  const [value, setValue] = useState<AlertConfig>({
    ...DEFAULT_ALERTS,
    eventVisuals: { ...DEFAULT_ALERTS.eventVisuals },
  });
  return (
    <SettingsMultiChatAlerts
      value={value}
      onChange={(next) => {
        spy(next);
        setValue(next);
      }}
    />
  );
}

describe("SettingsMultiChatAlerts", () => {
  it("offers a grouped visual picker for every normalized event kind", () => {
    render(<Harness />);

    for (const kind of CHAT_EVENT_KINDS) {
      const picker = screen.getByRole("combobox", {
        name: `${EVENT_KIND_LABEL[kind]} alert visual`,
      }) as HTMLSelectElement;
      expect(picker.value).toBe("classic");
      expect(picker.querySelector('option[value="shuffle"]')).toBeTruthy();
      expect(picker.querySelector('optgroup[label="Frog"]')).toBeTruthy();
      expect(picker.querySelector('optgroup[label="Money"]')).toBeTruthy();
      expect(picker.querySelector('optgroup[label="StarCraft"]')).toBeTruthy();
    }
  });

  it("updates the selected-kind preview through the shared alert renderer", () => {
    render(<Harness />);
    const raidPicker = screen.getByRole("combobox", {
      name: "Raid alert visual",
    });

    fireEvent.focus(raidPicker);
    fireEvent.change(raidPicker, { target: { value: "raid-boss" } });

    const preview = screen.getByTestId("alert-visual-preview");
    const card = preview.querySelector('[data-alert-preset="raid-boss"]');
    expect(card).toBeTruthy();
    expect(screen.getByText("Raid Boss")).toBeTruthy();
    expect(screen.getByText(/made specifically for raids/i)).toBeTruthy();
  });

  it("applies all-event quick actions without losing global controls", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);

    fireEvent.click(screen.getByRole("button", { name: "Shuffle all" }));
    for (const picker of screen.getAllByRole("combobox")) {
      expect((picker as HTMLSelectElement).value).toBe("shuffle");
    }

    fireEvent.click(screen.getByRole("button", { name: "Recommended mix" }));
    for (const picker of screen.getAllByRole("combobox")) {
      expect((picker as HTMLSelectElement).value).not.toBe("shuffle");
    }

    fireEvent.click(screen.getByRole("button", { name: /^Maximum\b/ }));
    fireEvent.change(screen.getByRole("slider", { name: "Alert time on screen" }), {
      target: { value: "15" },
    });
    fireEvent.click(screen.getByRole("switch", {
      name: "Show recent alert history",
    }));

    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({
      motion: "maximum",
      durationSec: 15,
      showHistory: false,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Classic all" }));
    for (const picker of screen.getAllByRole("combobox")) {
      expect((picker as HTMLSelectElement).value).toBe("classic");
    }
  });
});
