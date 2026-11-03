import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReadableStream } from "node:stream/web";
import { TextEncoder } from "node:util";
import { SWRConfig } from "swr";
import { SettingsExportCards } from "../SettingsExportCards";
import { useExportDownload } from "@/lib/exports/useExportDownload";
import { exportBusy } from "@/lib/exports/exportAdmission";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: "clerk-a", isLoaded: true, isSignedIn: true, getToken: async () => "synthetic" }),
}));
function reply(more: boolean, ok = true): Response {
  return { ok, headers: new Headers({ "content-type": "text/csv", "x-export-has-more": String(more),
    ...(more ? { "x-export-continuation-token": "opaque.next" } : {}) }),
  body: new ReadableStream<Uint8Array>({ start(source) { source.enqueue(new TextEncoder().encode("gameId,side,time,supply,name\n")); source.close(); } }) } as unknown as Response;
}
function Harness() {
  const download = useExportDownload();
  return <SettingsExportCards key={download.owner} download={download} />;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); expect(exportBusy()).toBe(false); });

describe("build export page recovery", () => {
  it("retains the token after actual picker cancellation and server failure, and retries only on another click", async () => {
    const writer = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    const picker = vi.fn(async () => ({ createWritable: async () => writer }));
    vi.stubGlobal("showSaveFilePicker", picker);
    const fetch = vi.fn().mockResolvedValueOnce(reply(true)).mockResolvedValueOnce(reply(false, false)).mockResolvedValueOnce(reply(false));
    vi.stubGlobal("fetch", fetch);
    const cache = new Map(); render(<SWRConfig value={{ provider: () => cache }}><Harness /></SWRConfig>);
    fireEvent.click(screen.getByRole("button", { name: "Download build orders" }));
    await screen.findByRole("button", { name: "Download next page" });
    picker.mockRejectedValueOnce(new DOMException("private picker detail", "AbortError"));
    fireEvent.click(screen.getByRole("button", { name: "Download next page" }));
    await screen.findByText("Export cancelled.");
    await waitFor(() => expect(exportBusy()).toBe(false));
    expect(fetch).toHaveBeenCalledOnce(); expect(screen.getByRole("button", { name: "Download next page" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download next page" }));
    await screen.findByText("Couldn't complete the export. Please try again.");
    await waitFor(() => expect(exportBusy()).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(2); expect(screen.getByRole("button", { name: "Download next page" })).toBeTruthy();
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get("continuation_token")).toBe("opaque.next");
    expect(screen.getByText(/Each page uses one request, including cancelled or failed downloads after admission/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download next page" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Download next page" })).toBeNull());
    await waitFor(() => expect(exportBusy()).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new URL(fetch.mock.calls[2][0]).searchParams.get("continuation_token")).toBe("opaque.next");
    expect(writer.close).toHaveBeenCalledTimes(2); expect(writer.abort).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain("Export saved");
    expect(document.body.textContent).not.toContain("private picker detail");
  });
});
