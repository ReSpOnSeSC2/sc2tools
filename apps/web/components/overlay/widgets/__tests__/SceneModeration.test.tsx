import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_STUDIO_STATE } from "@/lib/multichat/useStudioState";
import { DEFAULT_APPEARANCE } from "@/lib/multichat/appearance";
import { ChatPollWidget } from "../ChatPollWidget";
import { StreamSceneCanvas } from "../StreamSceneWidget";
let studio = { ...DEFAULT_STUDIO_STATE };
let appearance = { ...DEFAULT_APPEARANCE };
vi.mock("@/lib/multichat/useStudioState", async (original) => ({ ...await original<typeof import("@/lib/multichat/useStudioState")>(), useStudioState: () => studio }));
vi.mock("../MultiChatWidget", () => ({ useMultichatConfig: () => ({ platforms: {}, appearance }) }));
vi.mock("@/lib/multichat/useMultiChat", () => ({ useMultiChat: () => ({ messages: [{ platform: "twitch", id: "blocked", user: "Viewer", text: "2", badges: [], atMs: 1000 }] }) }));
beforeEach(() => { studio = { ...DEFAULT_STUDIO_STATE }; appearance = { ...DEFAULT_APPEARANCE }; });
afterEach(cleanup);
it.each([["starting", "STARTING SOON"], ["brb", "BE RIGHT BACK"], ["intermission", "INTERMISSION"], ["ending", "THANKS FOR WATCHING"]] as const)("renders %s accurately", (mode, headline) => {
  render(<StreamSceneCanvas scene={{ mode, message: "", setAtMs: 1, countdownEndsAt: null }} broll={DEFAULT_STUDIO_STATE.broll} remainMs={null} brollAudioOwner={false} videoFormat="horizontal" />);
  expect(screen.getByText(headline)).toBeTruthy();
});
it.each(["dock", "settings"])("omits a %s-blocked user's 2 vote", (source) => {
  studio.poll = { question: "Vote?", options: ["A", "B"], status: "open", startedAtMs: 1 };
  if (source === "dock") studio.blockedUsers = ["vIeWeR"]; else appearance.blockedUsers = "VIEWER";
  render(<ChatPollWidget token="token" />);
  expect(screen.getByText("0 votes")).toBeTruthy(); expect(screen.getAllByText("0 · 0%")).toHaveLength(2);
});
