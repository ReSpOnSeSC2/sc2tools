import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceBuildOrder } from "@/lib/buildOrderReference";
import { BuildEditorModal } from "./BuildEditorModal";
import { BuildOrderEditor } from "./BuildOrderEditor";
import { BuildOrderPaste } from "./BuildOrderPaste";
import { BuildOrderSteps } from "../BuildOrderSteps";

const h = vi.hoisted(() => ({ owner: "A", call: vi.fn(), token: vi.fn(async () => "token") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: h.owner, getToken: h.token }) }));
vi.mock("@/lib/clientApi", async original => ({ ...await original<typeof import("@/lib/clientApi")>(), apiCall: (...args: unknown[]) => h.call(...args), useApi: () => ({ data: undefined, isLoading: false }) }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => undefined }));
const order: ReferenceBuildOrder = { v: 1, source: "paste", steps: [{ t: null, supply: 14, action: "Unknown future action" }] };
beforeEach(() => { h.owner = "A"; h.call.mockResolvedValue({ saved: true, reclassify: null }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function Editor() { const [value, setValue] = useState(order); return <><BuildOrderEditor value={value} onChange={setValue} sourceEvents={[]} sourceGameId="private" race="Protoss" /><output aria-label="Saved reference">{JSON.stringify(value)}</output></>; }

describe("actual reference consumers", () => {
  it("saves an untimed unknown reference without classifying it and blocks a malformed clock", async () => {
    render(<BuildEditorModal open onClose={vi.fn()} events={[]} race="Protoss" vsRace="Any" defaultName="Reference plan" initialDraft={{ buildOrder: order }} />);
    expect(screen.getByRole("tab", { name: "Build order" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Skill level" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save build" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Save & re-match" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Step 1 time" }), { target: { value: "7:99" } });
    expect((screen.getByRole("button", { name: "Save build" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Step 1 time" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save build" }));
    await waitFor(() => expect(h.call.mock.calls.some(call => call[2]?.method === "PUT")).toBe(true));
    const body = JSON.parse(h.call.mock.calls.find(call => call[2]?.method === "PUT")![2].body);
    expect(body.buildOrder).toEqual(order); expect(body.rules).toEqual([]); expect(body.reclassify).toBe(false);
  });
  it("never fills a returned owner A editor from a held prior A request after A→B→A", async () => {
    let finish!: (data: unknown) => void; h.call.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const view = render(<Editor />); fireEvent.click(screen.getByRole("button", { name: "Fill from source game" }));
    expect(h.call).toHaveBeenCalledTimes(1);
    h.owner = "B"; view.rerender(<Editor />); h.owner = "A"; view.rerender(<Editor />);
    await act(async () => finish({ events: [{ time: 18, name: "Pylon", is_building: true, supply: 14 }] }));
    expect(screen.getByLabelText("Saved reference").textContent).toContain("Unknown future action");
    expect(screen.getByLabelText("Saved reference").textContent).not.toContain("BuildPylon");
  });
  it("loads only the explicitly selected source and allows keyboard row reordering", async () => {
    h.call.mockResolvedValue({ events: [{ time: 18, name: "Pylon", is_building: true }, { time: 30, name: "Gateway", is_building: true }] });
    render(<Editor />); fireEvent.click(screen.getByRole("button", { name: "Fill from source game" }));
    await waitFor(() => expect(screen.getByLabelText("Saved reference").textContent).toContain("BuildPylon"));
    fireEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));
    expect(JSON.parse(screen.getByLabelText("Saved reference").textContent!).steps.map((row: { action: string }) => row.action)).toEqual(["BuildGateway", "BuildPylon"]);
    expect(h.call).toHaveBeenCalledTimes(1); expect(h.call.mock.calls[0][1]).toBe("/v1/games/private/build-order");
  });
  it("shows per-line errors, forbids partial import, and keeps unknown-action warnings saveable", () => {
    const imported = vi.fn(); render(<BuildOrderPaste race="Protoss" onImport={imported} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Paste a build order" }), { target: { value: "14 - Future unit\nbad row" } });
    expect(screen.getByText(/Line 2 · Fix/)).toBeTruthy(); expect((screen.getByRole("button", { name: "Use pasted order" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Paste a build order" }), { target: { value: "14 - Future unit" } });
    fireEvent.click(screen.getByRole("button", { name: "Use pasted order" })); expect(imported).toHaveBeenCalledWith(expect.objectContaining({ steps: [{ t: null, supply: 14, action: "Future unit" }] }));
  });
  it("renders honest missing-clock and approximate-supply labels without leaking provenance", () => {
    render(<BuildOrderSteps value={{ ...order, sourceGameId: "private-secret", steps: [{ ...order.steps[0], supplyApprox: true, note: "<script>literal</script>" }] }} />);
    expect(screen.getByLabelText("Time unknown")).toHaveProperty("textContent", "—"); expect(screen.getByLabelText("Approximate supply 14")).toHaveProperty("textContent", "≈14");
    expect(document.querySelector("script")).toBeNull(); expect(document.body.textContent).not.toContain("private-secret");
  });
});
