import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const probe = vi.hoisted(() => ({ evaluated: 0 }));
vi.mock("./BuildEditorModal", () => { probe.evaluated++; return { BuildEditorModal: () => <p>Actual deferred module</p> }; });
import { BuildEditorIsland, LazyBuildEditorModal } from "./LazyBuildEditorModal";
const props = { open: true, onClose: vi.fn(), events: [], race: "Protoss" as const, vsRace: "Zerg" as const, perspective: "you" as const, gameId: "source-game" };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("optional rich editor loading", () => {
  it("does not evaluate the editor module until the consumer opens it", async () => {
    const view = render(<LazyBuildEditorModal {...props} open={false} />);
    expect(probe.evaluated).toBe(0); expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<LazyBuildEditorModal {...props} />); await screen.findByText("Actual deferred module"); expect(probe.evaluated).toBe(1);
  });
  it("contains a rejected import, retries the loader and preserves the page draft and exact source props", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const loader = vi.fn().mockRejectedValueOnce(new Error("ChunkLoadError")).mockResolvedValue((value: typeof props) => <p>{value.gameId}:{value.race}:{value.vsRace}</p>);
    function Parent() { const [draft, setDraft] = useState("Keep this draft"); return <><input aria-label="Surrounding draft" value={draft} onChange={event => setDraft(event.target.value)} /><BuildEditorIsland editorProps={props} loader={loader} /></>; }
    render(<Parent />); await screen.findByRole("dialog", { name: "Build editor could not load" });
    expect((screen.getByRole("textbox", { name: "Surrounding draft" }) as HTMLInputElement).value).toBe("Keep this draft");
    fireEvent.click(screen.getByRole("button", { name: "Retry editor" })); await screen.findByText("source-game:Protoss:Zerg");
    expect(loader).toHaveBeenCalledTimes(2); expect((screen.getByRole("textbox", { name: "Surrounding draft" }) as HTMLInputElement).value).toBe("Keep this draft");
  });
  it("lets Cancel close a pending chunk without waiting for its response", async () => {
    const close = vi.fn(), loader = vi.fn(() => new Promise<never>(() => undefined));
    render(<BuildEditorIsland editorProps={{ ...props, onClose: close }} loader={loader} />);
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1)); fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(close).toHaveBeenCalledOnce();
  });
});
