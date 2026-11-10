import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayStage } from "../ReplayStage";
import { payload } from "./fixtures";
import { parseReplayPreferences, REPLAY_PREFS_KEY } from "@/lib/useReplayPreferences";

vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: undefined, error: undefined, isLoading: false }) }));

beforeAll(async () => { await import("../clip/ClipDialog"); });
beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const savedVision = () => JSON.parse(window.localStorage.getItem(REPLAY_PREFS_KEY) || "{}").vision;

describe("replay vision setting", () => {
  it("cycles with V, announces the mode and persists it with the replay preferences", () => {
    render(<ReplayStage playback={payload()} myName="Ada" oppName="Rival" />);
    const stage = screen.getByTestId("replay-stage");
    stage.focus();
    fireEvent.keyDown(stage, { key: "v" });
    expect(screen.getByRole("status").textContent).toBe("Vision: Ada");
    expect(savedVision()).toBe("me");
    fireEvent.keyDown(stage, { key: "v" });
    fireEvent.keyDown(stage, { key: "v" });
    expect(savedVision()).toBe("off");
    fireEvent.keyDown(stage, { key: "v" });
    expect(savedVision()).toBe("both");
  });

  it("offers Both / you / opponent / Off in display settings and restores the choice", () => {
    window.localStorage.setItem(REPLAY_PREFS_KEY, JSON.stringify({ vision: "opp" }));
    render(<ReplayStage playback={payload()} oppName="Rival" />);
    fireEvent.click(screen.getByRole("button", { name: "Replay display settings" }));
    const vision = within(screen.getByRole("group", { name: "Vision" }));
    expect(vision.getAllByRole("button").map((button) => button.textContent)).toEqual(["Both", "You", "Rival", "Off"]);
    expect(vision.getByRole("button", { name: "Rival" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("replay-vision-badge").textContent).toContain("Rival");
    fireEvent.click(vision.getByRole("button", { name: "Off" }));
    expect(vision.getByRole("button", { name: "Off" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("replay-vision-badge")).toBeNull();
    expect(savedVision()).toBe("off");
  });

  it("accepts only known vision modes from storage", () => {
    expect(parseReplayPreferences(JSON.stringify({ vision: "me" }))).toEqual({ vision: "me" });
    expect(parseReplayPreferences(JSON.stringify({ vision: "selected" }))).toEqual({});
  });
});

describe("clip button", () => {
  it("appears only where the host allows clips and opens the clip dialog", async () => {
    const view = render(<ReplayStage playback={payload()} />);
    expect(screen.queryByRole("button", { name: "Clip" })).toBeNull();
    view.unmount();
    render(<ReplayStage playback={payload()} clip="shared" myRace="Zerg" oppRace="Terran" />);
    fireEvent.click(screen.getByRole("button", { name: "Clip" }));
    const dialog = await screen.findByTestId("clip-dialog");
    // jsdom can't record video or run workers: say so instead of failing later.
    expect(dialog.textContent).toContain("This browser can't make clips.");
    expect(screen.getByRole("button", { name: "Make clip" }).hasAttribute("disabled")).toBe(true);
    // Shared pages never offer the owner's player page as a watermark.
    expect(screen.queryByRole("radio", { name: /player page/i })).toBeNull();
    expect(screen.getByRole("radio", { name: "sc2tools.com" })).toBeTruthy();
  });
});
