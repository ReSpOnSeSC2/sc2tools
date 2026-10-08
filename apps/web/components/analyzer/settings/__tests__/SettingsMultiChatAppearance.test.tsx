import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { SettingsMultiChatAppearance } from "../SettingsMultiChatAppearance";
import { DEFAULT_APPEARANCE, type ChatAppearance } from "@/lib/multichat/appearance";

afterEach(cleanup);

describe("SettingsMultiChatAppearance stream readability", () => {
  it("enlarges the normal chat while retaining its layout, score choice and filters", () => {
    const onChange = vi.fn();
    const value = { ...DEFAULT_APPEARANCE, fontSize: 14, blockedUsers: "mybot", hideBots: true };
    render(<SettingsMultiChatAppearance value={value} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Compact text · 14px" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Extra large text · 32px" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...value, fontSize: 32 });
    fireEvent.change(screen.getByRole("slider", { name: /Text size/ }), { target: { value: "48" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, fontSize: 48 });
    fireEvent.click(screen.getByRole("button", { name: "Compact text · 14px" }));
    expect(onChange).toHaveBeenLastCalledWith(value);
  });

  it("previews the framed score preset and lets the streamer turn the score off", () => {
    const onChange = vi.fn();
    function Editor() {
      const [value, setValue] = useState<ChatAppearance>({
        ...DEFAULT_APPEARANCE, blockedUsers: "mybot", hideCommands: true, messageTtlSec: 60,
      });
      return <SettingsMultiChatAppearance value={value} onChange={(next) => { onChange(next); setValue(next); }} />;
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: /Classic chat \+ score/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      layout: "framed", fontSize: 28, messageColor: "#a6e879", showSessionScore: true,
      blockedUsers: "mybot", hideCommands: true, messageTtlSec: 60,
    }));
    expect(screen.getByTestId("mc-session-score").textContent).toContain("0 : 4");
    expect(screen.getByText(/sample 0:4 score/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Session score above chat" }));
    expect(screen.queryByTestId("mc-session-score")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      layout: "framed", fontSize: 28, showSessionScore: false,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Large text · 24px" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ layout: "framed", fontSize: 24 }));
  });
});

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
