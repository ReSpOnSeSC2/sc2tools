import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReplayDemo } from "../ReplayDemo";

const mock = vi.hoisted(() => ({ mode: "off", fetch: vi.fn(), browser: vi.fn(), editor: vi.fn() }));
vi.mock("@/lib/instant/flag", () => ({ getInstantImportMode: () => mock.mode }));
vi.mock("../ReplayDemoBrowserIsland", () => ({ ReplayDemoBrowserIsland: (props: unknown) => { mock.browser(props); return null; } }));
vi.mock("@/components/builds/editor/LazyBuildEditorModal", () => ({ LazyBuildEditorModal: (props: unknown) => { mock.editor(props); return null; } }));

beforeEach(() => { mock.fetch.mockReset(); mock.browser.mockClear(); mock.editor.mockClear(); mock.mode = "off"; vi.stubGlobal("fetch", mock.fetch); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["off", "admins"])("%s replaces the retired parser with desktop recovery and no intake or transport", (mode) => {
  mock.mode = mode;
  const { container } = render(<ReplayDemo />);
  const section = screen.getByRole("region", { name: "Turn a replay into a custom build" });
  expect(screen.getByText(/The replay demo is currently unavailable/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Get the desktop app" }).getAttribute("href")).toBe("/download");
  expect(screen.getByRole("link", { name: "Create a free account" }).getAttribute("href")).toBe("/sign-up");
  expect(container.querySelector('input[type="file"]')).toBeNull();
  expect(screen.queryByRole("button", { name: "Choose a replay" })).toBeNull();
  expect(screen.queryByRole("link", { name: "How this works" })).toBeNull();
  expect(container.querySelector('a[href^="/try"]')).toBeNull();
  expect(screen.queryByText(/Uploaded once to our server/)).toBeNull();
  fireEvent.pointerEnter(section); fireEvent.focus(section);
  fireEvent.drop(section, { dataTransfer: { types: ["Files"], files: [new File(["replay"], "game.SC2Replay")] } });
  expect(mock.browser).not.toHaveBeenCalled();
  expect(mock.editor).not.toHaveBeenCalled();
  expect(mock.fetch).not.toHaveBeenCalled();
});

it("all retains the private browser entry and only mounts its analyzer after intent", () => {
  mock.mode = "all";
  render(<ReplayDemo />);
  expect(screen.getByText("Runs in your browser — the replay never leaves your device.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "How this works" }).getAttribute("href")).toBe("/try#home-replay-demo");
  expect(mock.browser).not.toHaveBeenCalled();
  fireEvent.pointerEnter(screen.getByRole("heading", { name: "Turn a replay into a custom build" }).closest("section")!);
  expect(mock.browser).toHaveBeenCalled();
  expect(mock.fetch).not.toHaveBeenCalled();
});
