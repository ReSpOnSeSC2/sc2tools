import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsGameMoments } from "../SettingsGameMoments";
import { DEFAULT_SOUND } from "@/lib/multichat/sound";
import { visiblePresetsFor } from "@/lib/multichat/alerts";
import { sanitizeGameMomentConfig, type GameMomentConfig } from "@/lib/gameMoments";
const spies = vi.hoisted(() => ({ change: vi.fn(), preview: vi.fn() }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children, slug }: { children: React.ReactNode; slug: string }) => <a href={`/help/${slug}`}>{children}</a> }));
vi.mock("@/lib/multichat/sound", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/multichat/sound")>(), previewSound: (...args: unknown[]) => spies.preview(...args) }));
function Harness({ initial }: { initial?: GameMomentConfig }) {
  const [value, setValue] = useState(initial);
  return <SettingsGameMoments value={value} onChange={next => { spies.change(next); setValue(next); }} presets={visiblePresetsFor(false)} motion="full" sound={{ ...DEFAULT_SOUND, eventVolume: 40 }} />;
}
beforeEach(() => { spies.change.mockClear(); spies.preview.mockClear(); });
afterEach(cleanup);
it("does not write defaults or enable bot/sounds on mount", () => {
  const { container } = render(<Harness />); fireEvent.click(screen.getByText("Game moments", { exact: true }));
  expect(screen.getAllByRole("switch")).toHaveLength(10);
  expect(screen.getAllByRole("switch").every(control => control.getAttribute("aria-checked") === "false")).toBe(true);
  expect(spies.change).not.toHaveBeenCalled(); expect(spies.preview).not.toHaveBeenCalled();
  expect(container.querySelector('a[href="/help/game-moment-alerts"]')).toBeTruthy();
});
it("edits the complete controlled draft without dropping another moment's choices", () => {
  render(<Harness initial={sanitizeGameMomentConfig({ moments: { giantKiller: { enabled: true, preset: "classic", sound: "ding" } } })} />);
  fireEvent.click(screen.getByText("Game moments", { exact: true }));
  fireEvent.click(screen.getByRole("switch", { name: "Five or ten wins" }));
  fireEvent.change(screen.getByLabelText("MMR milestone spacing"), { target: { value: "250" } });
  fireEvent.change(screen.getByLabelText("Visual for Five or ten wins"), { target: { value: "classic" } });
  fireEvent.change(screen.getByLabelText("Sound for Five or ten wins"), { target: { value: "victory" } });
  expect(spies.change.mock.calls.at(-1)?.[0]).toMatchObject({ mmrStep: 250, botPost: false, moments: { winStreak: { enabled: true, preset: "classic", sound: "victory" }, giantKiller: { enabled: true, preset: "classic", sound: "ding" } } });
});
it("local Test uses the real Ladder renderer and selected sound without changing saved settings", () => {
  render(<Harness initial={sanitizeGameMomentConfig({ moments: { winStreak: { enabled: false, preset: "classic", sound: "victory" } } })} />);
  fireEvent.click(screen.getByText("Game moments", { exact: true })); fireEvent.click(screen.getByRole("button", { name: "Test Five or ten wins" }));
  const preview = screen.getByRole("region", { name: "Game moment preview" }); expect(within(preview).getByText("Ladder")).toBeTruthy(); expect(within(preview).getByText("TEST · Local preview")).toBeTruthy();
  expect(spies.preview).toHaveBeenCalledWith("victory", 40, expect.anything(), expect.any(String));
  expect(spies.change).not.toHaveBeenCalled(); expect(screen.getByRole("switch", { name: "Five or ten wins" }).getAttribute("aria-checked")).toBe("false");
});
it("offers non-admin-safe visual choices and explicit bot opt-in", () => {
  render(<Harness />); fireEvent.click(screen.getByText("Game moments", { exact: true }));
  const options = [...screen.getByLabelText("Visual for Five or ten wins").querySelectorAll("option")].map(option => option.value);
  expect(options).not.toContain("zealot-dance-3d");
  fireEvent.click(screen.getByRole("switch", { name: "Post moments through the configured Twitch bot" }));
  expect(spies.change.mock.calls.at(-1)?.[0].botPost).toBe(true);
});
