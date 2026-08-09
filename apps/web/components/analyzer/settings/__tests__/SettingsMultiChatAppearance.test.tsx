import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsMultiChatAppearance } from "../SettingsMultiChatAppearance";
import { DEFAULT_APPEARANCE } from "@/lib/multichat/appearance";

afterEach(cleanup);

describe("SettingsMultiChatAppearance message lifetime", () => {
  it("offers a one-click 30-second stream-only lifetime", () => {
    const onChange = vi.fn();
    render(
      <SettingsMultiChatAppearance
        value={DEFAULT_APPEARANCE}
        onChange={onChange}
      />,
    );

    expect(
      screen.getByText(/Stream Dock chat history is unchanged/i),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "30 sec" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("slider", { name: "Custom on-stream message lifetime" })
        .getAttribute("aria-valuetext"),
    ).toBe("30 seconds");

    fireEvent.click(screen.getByRole("button", { name: "Never" }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_APPEARANCE,
      messageTtlSec: 0,
    });

    fireEvent.change(
      screen.getByRole("slider", {
        name: "Custom on-stream message lifetime",
      }),
      { target: { value: "45" } },
    );
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_APPEARANCE,
      messageTtlSec: 45,
    });
  });
});
