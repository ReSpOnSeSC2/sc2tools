import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplayDemoBrowserIsland } from "../ReplayDemoBrowserIsland";
import type { BrowserDemoProps } from "../ReplayDemoBrowserSession";
const request = { file: new File(["x"], "local.SC2Replay"), id: 1 };
const props: BrowserDemoProps = { request, onClose: vi.fn(), onBusy: vi.fn(), onSuccess: vi.fn(), onChooseAnother: vi.fn() };
const Ready = () => <p>Ready browser fixture</p>;
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe("optional browser analyzer chunk", () => {
  it("retries a rejected import without a page-level crash", async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error("chunk failed")).mockResolvedValue(Ready);
    render(<ReplayDemoBrowserIsland {...props} loader={loader} />);
    await screen.findByText("The browser analyzer could not load"); fireEvent.click(screen.getByRole("button", { name: "Retry analyzer" }));
    await screen.findByText("Ready browser fixture"); expect(loader).toHaveBeenCalledTimes(2);
  });
  it("keeps the selected file visible and offers the picker after a chunk failure", async () => {
    const onChooseAnother = vi.fn(), loader = vi.fn().mockRejectedValue(new Error("chunk failed"));
    render(<ReplayDemoBrowserIsland {...props} onChooseAnother={onChooseAnother} loader={loader} />);
    await screen.findByText("The browser analyzer could not load");
    expect(screen.getByText("local.SC2Replay · 1 B")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose another replay" }));
    expect(onChooseAnother).toHaveBeenCalledOnce(); expect(loader).toHaveBeenCalledTimes(1);
  });
  it.each([[1, "1 B"], [1024, "1.00 KB"], [2 * 1024 * 1024, "2.00 MB"]] as const)("keeps a %i-byte filename/size readable through held chunk and failure", async (bytes, label) => {
    let fail!: (reason: Error) => void;
    const loader = vi.fn(() => new Promise<typeof Ready>((_resolve, reject) => { fail = reject; }));
    const selected = { file: new File([new Uint8Array(bytes)], "selected.SC2Replay"), id: 2 };
    render(<ReplayDemoBrowserIsland {...props} request={selected} loader={loader} />);
    expect(screen.getByText(`selected.SC2Replay · ${label}`)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Loading browser analyzer…" })).toBeTruthy();
    await act(async () => { await Promise.resolve(); fail(new Error("owned chunk failure")); });
    expect(screen.getByRole("dialog", { name: "The browser analyzer could not load" })).toBeTruthy();
    expect(screen.getByText(`selected.SC2Replay · ${label}`)).toBeTruthy();
    expect(screen.queryByText(/0\.00 MB/)).toBeNull(); expect(loader).toHaveBeenCalledOnce();
    expect(screen.getByText(/Your replay has not been uploaded/)).toBeTruthy();
  });
  it("retries a thrown component without rendering that stale component into the new attempt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Broken = () => { throw new Error("render failed"); };
    const loader = vi.fn().mockResolvedValueOnce(Broken).mockResolvedValue(Ready);
    render(<ReplayDemoBrowserIsland {...props} loader={loader} />);
    await screen.findByText("The browser analyzer could not load"); fireEvent.click(screen.getByRole("button", { name: "Retry analyzer" }));
    await screen.findByText("Ready browser fixture"); expect(loader).toHaveBeenCalledTimes(2);
  });
  it("bounds a held import and ignores its settlement after Retry", async () => {
    vi.useFakeTimers(); let finish!: (component: typeof Ready) => void;
    const loader = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(Ready);
    render(<ReplayDemoBrowserIsland {...props} loader={loader} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
    expect(screen.getByText("The browser analyzer could not load")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Retry analyzer" }));
    await act(async () => { await Promise.resolve(); }); expect(screen.getByText("Ready browser fixture")).toBeTruthy();
    await act(async () => finish(() => <p>Stale chunk</p>)); expect(screen.queryByText("Stale chunk")).toBeNull();
  });
});
