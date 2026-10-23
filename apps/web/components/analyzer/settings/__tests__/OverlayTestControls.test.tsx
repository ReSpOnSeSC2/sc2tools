import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OverlayLiveTestDialog, useOverlayTests } from "../OverlayTestControls";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({ default: ({ children, href, ...props }: { children: ReactNode; href: string }) => <a href={href} {...props}>{children}</a> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const answer = (status = 202, code = "") => new Response(JSON.stringify(code ? { error: { code, message: code } } : { ok: true }), { status, headers: { "content-type": "application/json" } });
function Controls() {
  const { toast } = useToast();
  const test = useOverlayTests(async () => "fixture-session", toast);
  return <><button onClick={() => { void test.testWidget("owned-token", "opponent"); }}>{test.testingWidget ? "Stop sample" : "Test opponent"}</button>
    <OverlayLiveTestDialog pending={test.pendingLiveTest} busy={test.testingWidget !== null} origin="https://fixture.local"
      onClose={() => test.setPendingLiveTest(null)} onSend={() => { if (test.pendingLiveTest) void test.testWidget(test.pendingLiveTest.token, test.pendingLiveTest.widget, true); }} /></>;
}
const mount = () => render(<ToastProvider><Controls /></ToastProvider>);

describe("Settings live-game Test confirmation", () => {
  it("requires Send anyway after the actual API 409 and sends force only after confirmation", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(answer(409, "live_match")).mockResolvedValueOnce(answer()); vi.stubGlobal("fetch", fetch);
    mount(); fireEvent.click(screen.getByRole("button", { name: "Test opponent" }));
    await screen.findByRole("dialog");
    expect(screen.getByText("You're in a game — viewers will see sample data for about 20 s")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token: "owned-token", widget: "opponent" });
    fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ token: "owned-token", widget: "opponent", force: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Stop sample" })).toBeTruthy();
  });
  it("offers a new-tab local preview and never sends a forced event when chosen", async () => {
    const fetch = vi.fn().mockResolvedValue(answer(409, "live_match")); vi.stubGlobal("fetch", fetch);
    mount(); fireEvent.click(screen.getByRole("button", { name: "Test opponent" }));
    const preview = await screen.findByRole("link", { name: /Preview here instead/ });
    expect(preview.getAttribute("href")).toBe("https://fixture.local/overlay/owned-token/widget/opponent?demo=1");
    expect(preview.getAttribute("target")).toBe("_blank"); expect(preview.getAttribute("rel")).toContain("noopener");
    fireEvent.click(preview); expect(screen.queryByRole("dialog")).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps ordinary failures retryable and Stop uses only the scoped cancel endpoint", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(answer()); vi.stubGlobal("fetch", fetch);
    mount(); fireEvent.click(screen.getByRole("button", { name: "Test opponent" }));
    await screen.findByText("Couldn't fire test event");
    fireEvent.click(screen.getByRole("button", { name: "Test opponent" }));
    const stop = await screen.findByRole("button", { name: "Stop sample" });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); fireEvent.click(stop);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls[2][0]).toContain("/v1/overlay-events/test/cancel");
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ token: "owned-token", widget: "opponent" });
  });
});
