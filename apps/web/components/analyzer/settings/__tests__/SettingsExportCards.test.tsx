import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsExportCards } from "../SettingsExportCards";
import type { useExportDownload } from "@/lib/exports/useExportDownload";
import { localDayStartIso, localNextDayStartIso } from "@/lib/localDateRange";

type Download = ReturnType<typeof useExportDownload>;
function model() {
  const run = vi.fn<Download["run"]>(async (_request, complete) => { complete?.({ bytes: 20, continuation: "opaque.next" }); return true; });
  return { owner: "clerk-a", apiOwner: "internal-a", busy: false, feedback: null, run, cancel: vi.fn(), clear: vi.fn() } satisfies Download;
}
afterEach(cleanup);

describe("Settings export cards", () => {
  it("requests streamed optional details with the internal API UUID and preserves private/archive copy", async () => {
    const download = model(); render(<SettingsExportCards download={download} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Include game details/ }));
    fireEvent.click(screen.getByRole("button", { name: "Download full archive" }));
    await waitFor(() => expect(download.run).toHaveBeenCalledOnce());
    expect(download.run).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("/v1/me/export?format=ndjson&details=1"),
      contentType: "application/x-ndjson", ndjson: { format: "sc2tools-account-export", apiOwner: "internal-a" } }));
    expect(screen.getByText(/Keep this file private/)).toBeTruthy();
    expect(screen.getByText(/up to 128 MiB/)).toBeTruthy();
  });

  it("binds each successful continuation to the selected format/range and sends the exact server query key", async () => {
    const download = model(); render(<SettingsExportCards download={download} />);
    fireEvent.change(screen.getByLabelText("Export games from"), { target: { value: "2026-10-31" } });
    fireEvent.change(screen.getByLabelText("Export games through"), { target: { value: "2026-11-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Download build orders" }));
    const next = await screen.findByRole("button", { name: "Download next page" }); fireEvent.click(next);
    await waitFor(() => expect(download.run).toHaveBeenCalledTimes(2));
    const url = new URL(download.run.mock.calls[1][0].url);
    expect(url.pathname).toBe("/v1/export/build-orders.csv");
    expect(Object.fromEntries(url.searchParams)).toEqual({ since: localDayStartIso("2026-10-31"), until: localNextDayStartIso("2026-11-01"), continuation_token: "opaque.next" });
    fireEvent.change(screen.getByLabelText("Build-order export format"), { target: { value: "ndjson" } });
    expect(screen.queryByRole("button", { name: "Download next page" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download build orders" }));
    await waitFor(() => expect(download.run).toHaveBeenCalledTimes(3));
    expect(download.run.mock.calls[2][0]).toMatchObject({ contentType: "application/x-ndjson", ndjson: { format: "sc2tools-build-order-export" } });
    expect(new URL(download.run.mock.calls[2][0].url).searchParams.has("continuation_token")).toBe(false);
  });

  it("disables invalid ranges, incomplete identity and busy operations without spending a request", () => {
    const download = model(); download.apiOwner = "";
    const { rerender } = render(<SettingsExportCards download={download} />);
    expect((screen.getByRole("button", { name: "Download full archive" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Export games from"), { target: { value: "2026-11-02" } });
    fireEvent.change(screen.getByLabelText("Export games through"), { target: { value: "2026-11-01" } });
    expect((screen.getByRole("button", { name: "Download build orders" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<SettingsExportCards download={{ ...download, busy: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Download build orders" })); expect(download.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" })); expect(download.cancel).toHaveBeenCalledOnce();
  });

  it("keeps the same cursor after an unsuccessful page until an explicit successful retry", async () => {
    const download = model(); render(<SettingsExportCards download={download} />);
    fireEvent.click(screen.getByRole("button", { name: "Download build orders" }));
    await screen.findByRole("button", { name: "Download next page" });
    download.run.mockImplementationOnce(async () => false);
    fireEvent.click(screen.getByRole("button", { name: "Download next page" }));
    await waitFor(() => expect(download.run).toHaveBeenCalledTimes(2));
    expect(new URL(download.run.mock.calls[1][0].url).searchParams.get("continuation_token")).toBe("opaque.next");
    expect(screen.getByRole("button", { name: "Download next page" })).toBeTruthy();
    expect(download.run).toHaveBeenCalledTimes(2);
    download.run.mockImplementationOnce(async (_request, complete) => { complete?.({ bytes: 30, continuation: "opaque.third" }); return true; });
    fireEvent.click(screen.getByRole("button", { name: "Download next page" }));
    await waitFor(() => expect(download.run).toHaveBeenCalledTimes(3));
    expect(new URL(download.run.mock.calls[2][0].url).searchParams.get("continuation_token")).toBe("opaque.next");
    download.run.mockImplementationOnce(async (_request, complete) => { complete?.({ bytes: 10, continuation: null }); return true; });
    fireEvent.click(screen.getByRole("button", { name: "Download next page" }));
    await waitFor(() => expect(download.run).toHaveBeenCalledTimes(4));
    expect(new URL(download.run.mock.calls[3][0].url).searchParams.get("continuation_token")).toBe("opaque.third");
    expect(screen.queryByRole("button", { name: "Download next page" })).toBeNull();
  });

  it("clears saved page progress on an explicit restart, changed range or owner transition", async () => {
    const download = model(); const { rerender } = render(<SettingsExportCards key={download.owner} download={download} />);
    fireEvent.click(screen.getByRole("button", { name: "Download build orders" }));
    await screen.findByRole("button", { name: "Download next page" });
    download.run.mockImplementationOnce(async () => false);
    fireEvent.click(screen.getByRole("button", { name: "Download build orders" }));
    await waitFor(() => expect(download.run).toHaveBeenCalledTimes(2));
    expect(new URL(download.run.mock.calls[1][0].url).searchParams.has("continuation_token")).toBe(false);
    expect(screen.queryByRole("button", { name: "Download next page" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download build orders" }));
    await screen.findByRole("button", { name: "Download next page" });
    fireEvent.change(screen.getByLabelText("Export games from"), { target: { value: "2026-11-01" } });
    expect(screen.queryByRole("button", { name: "Download next page" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download build orders" }));
    await screen.findByRole("button", { name: "Download next page" });
    rerender(<SettingsExportCards key="clerk-b" download={{ ...download, owner: "clerk-b", apiOwner: "internal-b" }} />);
    expect(screen.queryByRole("button", { name: "Download next page" })).toBeNull();
  });
});
