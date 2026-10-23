import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReplayDemo } from "../ReplayDemo";
const mock = vi.hoisted(() => ({ mode: "all", fetch: vi.fn() }));
vi.mock("@/lib/instant/flag", () => ({ getInstantImportMode: () => mock.mode }));
vi.mock("@/components/builds/editor", () => ({ BuildEditorModal: () => null }));
beforeEach(() => { mock.fetch.mockReset(); mock.mode = "all"; vi.stubGlobal("fetch", mock.fetch); mock.fetch.mockResolvedValue({ ok: false, status: 504, headers: new Headers(), json: async () => ({ error: { code: "preview_timeout" } }) }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function replay() { const file = new File(["replay"], "game.SC2Replay"); Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(6) }); return file; }
function card() { return screen.getByRole("heading", { name: "Turn a replay into a custom build" }).closest("section")!; }
it("accepts a real drop, keeps the highlight over children and offers recovery", async () => {
  render(<ReplayDemo />); const file = replay(); const dataTransfer = { types: ["Files"], files: [file] };
  fireEvent.dragEnter(card(), { dataTransfer }); fireEvent.dragEnter(screen.getByText("Build editor demo"), { dataTransfer });
  fireEvent.dragLeave(screen.getByText("Build editor demo"), { dataTransfer }); expect(screen.getByText("Drop to analyze")).toBeTruthy();
  fireEvent.drop(card(), { dataTransfer });
  const heading = await screen.findByText("Couldn't parse that replay");
  await waitFor(() => expect(document.activeElement).toBe(heading)); expect(mock.fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Choose another replay" })).toBeTruthy(); expect(screen.getByRole("link", { name: "Analyze it in your browser" }).getAttribute("href")).toBe("/try");
});
it("rejects non-replays without a request and ignores text drags", () => {
  render(<ReplayDemo />); fireEvent.drop(card(), { dataTransfer: { types: ["Files"], files: [new File(["text"], "readme.txt")] } });
  expect(screen.getByRole("alert").textContent).toContain("isn't a .SC2Replay"); expect(mock.fetch).not.toHaveBeenCalled();
  expect(fireEvent.dragOver(card(), { dataTransfer: { types: ["text/plain"] } })).toBe(true);
});
it("resets the picker so the same replay can be selected again", async () => {
  mock.mode = "off"; const { container } = render(<ReplayDemo />); const input = container.querySelector<HTMLInputElement>('input[type="file"]')!; const file = replay();
  fireEvent.change(input, { target: { files: [file] } }); await screen.findByRole("button", { name: "Choose another replay" }); expect(input.value).toBe("");
  fireEvent.change(input, { target: { files: [file] } }); await waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("link", { name: "Analyze it in your browser" })).toBeNull();
});
