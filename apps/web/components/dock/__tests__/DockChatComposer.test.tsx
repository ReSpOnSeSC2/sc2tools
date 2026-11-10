import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DockChatComposer } from "../DockChatComposer";

vi.mock("@/lib/clientApi", () => ({
  API_BASE: "http://chat.test",
  boundedApiRequest: (operation: (signal: AbortSignal) => Promise<unknown>, _timeout: number, signal: AbortSignal) => operation(signal),
  buildApiError: async (response: Response) => ({ status: response.status, ...(await response.json()).error }),
}));

const OPTIONS = [
  { platform: "twitch", available: true, identity: "streamerbot", maxLength: 450 },
  { platform: "kick", available: true, identity: "streamer", maxLength: 500 },
  { platform: "youtube", available: true, identity: "streamer", maxLength: 200 },
  { platform: "tiktok", available: false, reason: "TikTok does not support sending from this Dock.", maxLength: 200 },
];
const config = { twitch: { enabled: true, channel: "streamer" }, kick: { enabled: true, channel: "streamer", chatroomId: 42 },
  youtube: { enabled: true, channel: "@streamer" }, tiktok: { enabled: true, username: "streamer" } };
function fixture(send: (init: RequestInit) => Promise<Response> = async () => Response.json({ results: [
  { platform: "twitch", status: "queued" }, { platform: "kick", status: "sent" }, { platform: "youtube", status: "sent" },
] })) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit = {}) => init.method === "POST" ? send(init) : Response.json({ platforms: OPTIONS }));
  vi.stubGlobal("fetch", fetchMock);
  const invalid = vi.fn();
  const view = render(<DockChatComposer token="dock-a" platforms={config} loaded onInvalid={invalid} />);
  return { ...view, fetchMock, invalid };
}
async function ready() { await waitFor(() => expect((screen.getByRole("checkbox", { name: "Send to Twitch" }) as HTMLInputElement).disabled).toBe(false)); }
function type(text = "Hello everyone!") { fireEvent.change(screen.getByRole("textbox", { name: "Chat message" }), { target: { value: text } }); }
const posts = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.filter(([, init]) => init?.method === "POST");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Dock chat composer", () => {
  it("sends to all available platforms and excludes unsupported TikTok", async () => {
    const { fetchMock } = fixture(); await ready();
    expect((screen.getByRole("checkbox", { name: "Send to TikTok" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/TikTok does not support sending from this Dock\./)).toBeTruthy();
    type(); fireEvent.submit(screen.getByRole("form", { name: "Send chat message" }));
    await screen.findByText("Twitch: Queued");
    expect(JSON.parse(posts(fetchMock)[0][1].body as string)).toEqual({ text: "Hello everyone!", platforms: ["twitch", "kick", "youtube"] });
    expect((screen.getByRole("textbox", { name: "Chat message" }) as HTMLInputElement).value).toBe("");
  });

  it("allows a selected destination and sends only once while pending", async () => {
    let complete!: (value: Response) => void;
    const { fetchMock } = fixture(() => new Promise(resolve => { complete = resolve; })); await ready();
    fireEvent.click(screen.getByRole("checkbox", { name: "Send to Kick" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Send to YouTube" }));
    type();
    const form = screen.getByRole("form", { name: "Send chat message" });
    fireEvent.submit(form); fireEvent.submit(form);
    expect(posts(fetchMock)).toHaveLength(1);
    expect(JSON.parse(posts(fetchMock)[0][1].body as string).platforms).toEqual(["twitch"]);
    await act(async () => complete(Response.json({ results: [{ platform: "twitch", status: "queued" }] })));
  });

  it("keeps failed destinations selected after partial delivery without repeating successful sends", async () => {
    const { fetchMock } = fixture(async () => Response.json({ results: [
      { platform: "twitch", status: "queued" }, { platform: "kick", status: "failed", message: "Reconnect Kick." }, { platform: "youtube", status: "sent" },
    ] })); await ready(); type(); fireEvent.submit(screen.getByRole("form", { name: "Send chat message" }));
    await screen.findByText("Kick: Reconnect Kick.");
    expect((screen.getByRole("textbox", { name: "Chat message" }) as HTMLInputElement).value).toBe("Hello everyone!");
    expect((screen.getByRole("checkbox", { name: "Send to Twitch" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Send to Kick" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "Send chat message" }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(2));
    expect(JSON.parse(posts(fetchMock)[1][1].body as string).platforms).toEqual(["kick"]);
  });

  it("retains the draft and reports uncertain delivery after a lost response", async () => {
    fixture(async () => { throw new TypeError("network error"); }); await ready(); type();
    fireEvent.submit(screen.getByRole("form", { name: "Send chat message" }));
    await screen.findByText("Twitch: Delivery unconfirmed. Check chat before sending again.");
    expect((screen.getByRole("textbox", { name: "Chat message" }) as HTMLInputElement).value).toBe("Hello everyone!");
    expect((screen.getByRole("checkbox", { name: "Send to Twitch" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("rejects empty messages and enforces the shortest selected platform limit", async () => {
    const { fetchMock } = fixture(); await ready(); type("   ");
    fireEvent.submit(screen.getByRole("form", { name: "Send chat message" }));
    type("a".repeat(201)); fireEvent.submit(screen.getByRole("form", { name: "Send chat message" }));
    expect(posts(fetchMock)).toHaveLength(0);
    fireEvent.click(screen.getByRole("checkbox", { name: "Send to YouTube" }));
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the old draft when the Dock credential changes and reports revoked links", async () => {
    const { rerender, invalid } = fixture(); await ready(); type("private draft");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "overlay_token_replaced" } }, { status: 401 })));
    rerender(<DockChatComposer token="dock-b" platforms={config} loaded onInvalid={invalid} />);
    await waitFor(() => expect(invalid).toHaveBeenCalledWith(true));
    expect((screen.getByRole("textbox", { name: "Chat message" }) as HTMLInputElement).value).toBe("");
  });
});
