import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReplayDemo } from "../ReplayDemo";
const mock = vi.hoisted(() => ({ mode: "off", fetch: vi.fn(), editor: vi.fn() }));
vi.mock("@/lib/instant/flag", () => ({ getInstantImportMode: () => mock.mode }));
vi.mock("@/components/builds/editor/LazyBuildEditorModal", () => ({ LazyBuildEditorModal: (props: unknown) => { mock.editor(props); return null; } }));
beforeEach(() => { mock.fetch.mockReset(); mock.editor.mockClear(); mock.mode = "off"; vi.stubGlobal("fetch", mock.fetch); mock.fetch.mockResolvedValue({ ok: false, status: 504, headers: new Headers(), json: async () => ({ error: { code: "preview_timeout" } }) }); });
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
  expect(screen.getByRole("button", { name: "Choose another replay" })).toBeTruthy(); expect(screen.queryByRole("link", { name: "Analyze it in your browser" })).toBeNull();
});
it("rejects non-replays without a request and ignores text drags", () => {
  render(<ReplayDemo />); fireEvent.drop(card(), { dataTransfer: { types: ["Files"], files: [new File(["text"], "readme.txt")] } });
  expect(screen.getByRole("alert").textContent).toContain("isn't a .SC2Replay"); expect(mock.fetch).not.toHaveBeenCalled();
  expect(fireEvent.dragOver(card(), { dataTransfer: { types: ["text/plain"] } })).toBe(true);
});
it("resets the picker so the same replay can be selected again", async () => {
  mock.mode = "off"; const { container } = render(<ReplayDemo />); const input = container.querySelector<HTMLInputElement>('input[type="file"]')!; const file = replay();
  expect(input.accept).toBe(".SC2Replay");
  fireEvent.change(input, { target: { files: [file] } }); await screen.findByRole("button", { name: "Choose another replay" }); expect(input.value).toBe("");
  fireEvent.change(input, { target: { files: [file] } }); await waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("link", { name: "Analyze it in your browser" })).toBeNull();
});
it("aborts compatibility parsing on close and never opens an editor from its late response", async () => {
  let finish!: (value: unknown) => void; mock.fetch.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  mock.mode = "admins"; const view = render(<ReplayDemo />); const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [replay()] } }); await waitFor(() => expect(mock.fetch).toHaveBeenCalledOnce());
  const signal = mock.fetch.mock.calls[0][1].signal as AbortSignal;
  fireEvent.click(screen.getByRole("button", { name: "Close" })); expect(signal.aborted).toBe(true);
  finish({ ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true, game_id: "late", map: "Map", duration_sec: 60, date: "2020-01-01", players: [] }) });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mock.editor.mock.calls.every(([props]) => props.open === false)).toBe(true);
});
