import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ReadableStream } from "node:stream/web";
import { TextEncoder } from "node:util";
import { SWRConfig } from "swr";
import AccountDeleteDialog from "../AccountDeleteDialog";
import { useExportDownload } from "@/lib/exports/useExportDownload";
import { exportBusy } from "@/lib/exports/exportAdmission";

const auth = vi.hoisted(() => ({ owner: "clerk-a", token: vi.fn(async (): Promise<string | null> => "synthetic") }));
const erase = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: auth.owner, isLoaded: true, isSignedIn: true, getToken: auth.token }),
  useClerk: () => ({ signOut: vi.fn() }),
}));
vi.mock("@/lib/clientApi", async original => ({
  ...(await original<typeof import("@/lib/clientApi")>()),
  apiCall: erase,
  useApi: () => ({ data: { removed: {}, anonymized: {}, countedAt: "2026-11-02" } }),
}));
vi.mock("@/components/legal/BackupRetention", () => ({ BackupRetention: () => <p>Backup retention</p> }));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function reply(): Response {
  return { ok: true, headers: new Headers({ "content-type": "application/json" }),
    body: new ReadableStream<Uint8Array>({ start(source) { source.enqueue(new TextEncoder().encode("{}")); source.close(); } }) } as unknown as Response;
}
function Harness() {
  const download = useExportDownload();
  const exportData = () => download.run({ url: "https://api.example.test/v1/me/export", filename: "private.json", contentType: "application/json" });
  return <AccountDeleteDialog key={download.owner} onClose={vi.fn()} onExport={exportData} exportStatus={download} />;
}
function setup() {
  const cache = new Map();
  return render(<SWRConfig value={{ provider: () => cache }}><Harness /></SWRConfig>);
}
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); auth.owner = "clerk-a";
  auth.token.mockReset().mockResolvedValue("synthetic"); erase.mockReset();
  expect(exportBusy()).toBe(false);
});

describe("account-delete export feedback", () => {
  it("shows cancellation inside the modal and blocks continuing through actual file cleanup", async () => {
    const entered = deferred(), written = deferred(), cleaned = deferred();
    const writer = { write: vi.fn(async () => { entered.resolve(); await written.promise; }),
      close: vi.fn(async () => {}), abort: vi.fn(() => cleaned.promise) };
    vi.stubGlobal("fetch", vi.fn(async () => reply()));
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => ({ createWritable: async () => writer })));
    setup(); const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Download my data" }));
    try {
      await entered.promise;
      expect(within(dialog).getByRole("status").textContent).toContain("Preparing export");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel export" }));
      await within(dialog).findByText("Export cancelled.");
      await waitFor(() => expect(writer.abort).toHaveBeenCalledOnce());
      expect(exportBusy()).toBe(true);
      expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(true);
      expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(true);
      fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
      expect(within(dialog).getByText("Step 1 of 3")).toBeTruthy();
      await act(async () => { written.resolve(); });
      expect(exportBusy()).toBe(true); expect(writer.close).not.toHaveBeenCalled();
      await act(async () => { cleaned.resolve(); });
      await waitFor(() => expect(exportBusy()).toBe(false));
      expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(false);
      fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
      expect(within(dialog).getByText("What happens to your data")).toBeTruthy();
      expect(erase).not.toHaveBeenCalled();
    } finally { written.resolve(); cleaned.resolve(); await waitFor(() => expect(exportBusy()).toBe(false)); }
  });

  it("shows successful output and fixed private failures in the modal without requiring export", async () => {
    const writer = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    const fetch = vi.fn(async () => reply()); vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => ({ createWritable: async () => writer })));
    setup(); const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Download my data" }));
    await within(dialog).findByText(/Export saved\. Check your downloads/);
    expect(writer.close).toHaveBeenCalledOnce();
    auth.token.mockRejectedValueOnce(new Error("private-jwt-detail"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Download my data" }));
    await within(dialog).findByText("Couldn't complete the export. Please try again.");
    expect(dialog.textContent).not.toContain("private-jwt-detail"); expect(fetch).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByText("What happens to your data")).toBeTruthy();
    expect(erase).not.toHaveBeenCalled();
  });

  it("does not carry held old-owner feedback into a fresh A→B→A modal", async () => {
    const jwt = deferred<string | null>(); auth.token.mockImplementationOnce(() => jwt.promise);
    const writer = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    const fetch = vi.fn(async () => reply()); vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => ({ createWritable: async () => writer })));
    const { rerender } = setup();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Download my data" }));
    try {
      await waitFor(() => expect(auth.token).toHaveBeenCalledOnce());
      auth.owner = "clerk-b"; rerender(<SWRConfig><Harness /></SWRConfig>);
      auth.owner = "clerk-a"; rerender(<SWRConfig><Harness /></SWRConfig>);
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).queryByRole("status")).toBeNull(); expect(exportBusy()).toBe(true);
      await act(async () => { jwt.resolve("old-token"); });
      await waitFor(() => expect(exportBusy()).toBe(false));
      expect(within(dialog).queryByRole("status")).toBeNull();
      expect(fetch).not.toHaveBeenCalled(); expect(writer.close).not.toHaveBeenCalled(); expect(writer.abort).toHaveBeenCalledOnce();
    } finally { jwt.resolve("old-token"); await waitFor(() => expect(exportBusy()).toBe(false)); }
  });
});
