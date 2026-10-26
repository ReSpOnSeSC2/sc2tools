import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { SWRConfig, unstable_serialize } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsContextProvider, usePublishDirty } from "../SettingsContext";
import { SettingsStreamingTokenOwner, useSettingsStreamingToken } from "../SettingsStreamingTokenOwner";

const auth = vi.hoisted(() => ({ owner: "owner-a" as string | null, getToken: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: !!auth.owner, userId: auth.owner, getToken: auth.getToken }) }));
const token = (id: string, extra = {}) => ({ token: id, label: id, createdAt: "2026-10-26", ...extra });
const list = (...ids: string[]) => ({ items: ids.map(id => token(id)) });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const text = (element: HTMLElement) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
const reads: string[] = [];
const writes: { method: string; body: string | null }[] = [];
let transport: (url: string, init: RequestInit) => Promise<Response>;
let cache: Map<string, { data?: unknown }>;
let heldProbe: (() => Promise<string | null>) | null = null;
function Probe({ dirty = false, label = "overlay" }: { dirty?: boolean; label?: string }) {
  const value = useSettingsStreamingToken();
  usePublishDirty("chat", dirty);
  heldProbe = value.getToken;
  return <p data-testid="body">{label}:{value.ownerId}:{value.token.token}:{value.credential.key}</p>;
}
function Harness({ children, strict = false }: { children: ReactNode; strict?: boolean }) {
  const content = <SWRConfig value={{ provider: () => cache, dedupingInterval: 2000 }}><SettingsContextProvider>{children}</SettingsContextProvider></SWRConfig>;
  return strict ? <StrictMode>{content}</StrictMode> : content;
}
function owner(children: ReactNode = <Probe />, strict = false) { return <Harness strict={strict}><SettingsStreamingTokenOwner section="setup">{children}</SettingsStreamingTokenOwner></Harness>; }
beforeEach(() => {
  auth.owner = "owner-a"; auth.getToken.mockReset().mockResolvedValue("synthetic-bearer");
  cache = new Map(); reads.length = 0; writes.length = 0; heldProbe = null;
  transport = async (_url, init) => init.method === "POST" ? reply({ token: "new-token" }) : reply(list("a", "b"));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET") reads.push(new URL(String(input), "http://fixture.invalid").pathname);
    else writes.push({ method, body: typeof init.body === "string" ? init.body : null });
    return transport(String(input), init);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("one admitted streaming-token authority", () => {
  it("forces one current status read, retains selection between the two bodies and renders one manager", async () => {
    const view = render(owner());
    expect(text(await screen.findByTestId("body"))).toContain("overlay:owner-a:a");
    fireEvent.change(screen.getByLabelText("URLs shown for"), { target: { value: "b" } });
    expect(text(screen.getByTestId("body"))).toContain("owner-a:b");
    view.rerender(owner(<Probe label="chat" />));
    expect(text(screen.getByTestId("body"))).toContain("chat:owner-a:b");
    expect(screen.getAllByLabelText("URLs shown for")).toHaveLength(1);
    const shared = screen.getByRole("region", { name: "Shared streaming token controls" });
    expect(shared.id).toBe("tokens"); expect(document.querySelectorAll('[id="tokens"]')).toHaveLength(1);
    expect(shared.compareDocumentPosition(screen.getByTestId("body")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reads).toEqual(["/v1/overlay-tokens"]); expect(writes).toEqual([]);
  });
  it("never admits a warm empty list or warm token before its fresh status completes", async () => {
    cache.set(unstable_serialize(["authenticated-api", "owner-a", "/v1/overlay-tokens"]), { data: list() });
    const held = deferred<Response>(); transport = () => held.promise;
    render(owner()); await waitFor(() => expect(reads).toHaveLength(1));
    expect(screen.queryByTestId("body")).toBeNull(); expect(writes).toEqual([]);
    await act(async () => held.resolve(reply(list("fresh"))));
    expect(text(await screen.findByTestId("body"))).toContain("fresh");
    expect(writes).toEqual([]);
  });
  it("a failed GET cannot mint; a successful explicit status retry admits exactly one Default", async () => {
    let status = 0;
    transport = async (_url, init) => init.method === "POST" ? reply({ token: "new-token" }) : ++status === 1 ? reply({ error: { message: "offline", code: "unavailable" } }, 503) : reply(status === 2 ? list() : list("new-token"));
    render(owner()); expect(text(await screen.findByRole("alert"))).toContain("offline");
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Check token status" }));
    expect(text(await screen.findByTestId("body"))).toContain("new-token");
    expect(reads).toHaveLength(3); expect(writes).toEqual([{ method: "POST", body: JSON.stringify({ label: "Default" }) }]);
  });
  it("retains unknown automatic creation across full unmount/remount and empty status without a second POST", async () => {
    const ack = deferred<Response>();
    transport = async (_url, init) => init.method === "POST" ? ack.promise : reply(list());
    const view = render(owner()); await waitFor(() => expect(writes).toHaveLength(1));
    view.unmount();
    render(owner());
    expect(await screen.findByText(/A token change may have completed/)).toBeTruthy();
    expect(reads).toHaveLength(2); expect(writes).toHaveLength(1);
    expect(screen.queryByTestId("body")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check token status" }));
    await waitFor(() => expect(reads).toHaveLength(3));
    expect(writes).toHaveLength(1);
    await act(async () => ack.resolve(reply({ token: "late-private-token" })));
    expect(screen.queryByText(/late-private-token/)).toBeNull();
    expect(writes).toHaveLength(1);
    expect(cache.get(unstable_serialize(["settings-streaming-create-ambiguity", "owner-a"]))).toMatchObject({ data: { blocked: true, generation: expect.any(Object) } });
    expect(JSON.stringify(cache.get(unstable_serialize(["settings-streaming-create-ambiguity", "owner-a"]))!.data)).toBe('{"blocked":true,"generation":{"mayClear":true}}');
  });
  it.each([{}, { token: "acknowledged-but-missing" }])("retains successful-but-unadmitted creation %j across remount without reminting", async acknowledgement => {
    transport = async (_url, init) => init.method === "POST" ? reply(acknowledgement) : reply(list());
    const view = render(owner());
    expect(await screen.findByText(/A token change may have completed/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Create a token explicitly" })).toBeTruthy();
    expect(reads).toHaveLength(2); expect(writes).toHaveLength(1);
    expect(cache.get(unstable_serialize(["settings-streaming-create-ambiguity", "owner-a"]))).toMatchObject({ data: { blocked: true, generation: expect.any(Object) } });
    view.unmount();
    render(owner());
    expect(await screen.findByText(/A token change may have completed/)).toBeTruthy();
    expect(reads).toHaveLength(3); expect(writes).toHaveLength(1);
    expect(screen.queryByTestId("body")).toBeNull();
    expect(cache.get(unstable_serialize(["settings-streaming-create-ambiguity", "owner-a"]))).toMatchObject({ data: { blocked: true, generation: expect.any(Object) } });
  });
  it("requires a post-uncertainty status read before explicit creation; a failed status cannot authorize it", async () => {
    let gets = 0;
    transport = async (_url, init) => {
      if (init.method === "POST") throw new TypeError("Synthetic ACK lost");
      gets += 1;
      return gets === 2 ? reply({ error: { code: "unavailable", message: "status unavailable" } }, 503) : reply(list());
    };
    render(owner());
    expect(await screen.findByText(/A token change may have completed/)).toBeTruthy();
    expect(writes).toHaveLength(1); expect(screen.queryByRole("button", { name: "Create a token explicitly" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check token status" }));
    expect(await screen.findByText("status unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create a token explicitly" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check token status" }));
    expect(await screen.findByRole("button", { name: "Create a token explicitly" })).toBeTruthy();
    expect(reads).toHaveLength(3); expect(writes).toHaveLength(1);
  });
  it("settles a stalled initial JWT at 15 seconds without treating failure as an empty list", async () => {
    vi.useFakeTimers(); const jwt = deferred<string>(); auth.getToken.mockReturnValueOnce(jwt.promise);
    render(owner());
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(text(screen.getByRole("alert"))).toMatch(/took too long/);
    expect(reads).toEqual([]); expect(writes).toEqual([]);
    await act(async () => jwt.resolve("late-jwt"));
    expect(reads).toEqual([]); expect(writes).toEqual([]);
  });
  it("does not remint on Strict Mode replay after one dispatched attempt", async () => {
    let minted = false;
    transport = async (_url, init) => { if (init.method === "POST") { minted = true; return reply({ token: "new-token" }); } return reply(minted ? list("new-token") : list()); };
    render(owner(<Probe />, true));
    expect(text(await screen.findByTestId("body"))).toContain("new-token");
    expect(writes).toHaveLength(1);
  });
  it("retires held owner-A JWT on A→B→A without fetching or committing the old generation", async () => {
    const jwt = deferred<string>(); auth.getToken.mockImplementationOnce(() => jwt.promise);
    const view = render(owner());
    await waitFor(() => expect(auth.getToken).toHaveBeenCalledOnce());
    auth.owner = "owner-b"; view.rerender(owner());
    expect(text(await screen.findByTestId("body"))).toContain("owner-b");
    auth.owner = "owner-a"; view.rerender(owner());
    expect(text(await screen.findByTestId("body"))).toContain("owner-a");
    await act(async () => jwt.resolve("retired-bearer"));
    expect(reads).toHaveLength(2); expect(writes).toEqual([]);
  });
  it("does not cache or render a retired owner's held response body", async () => {
    const body = deferred<unknown>();
    transport = async () => ({ ok: true, status: 200, json: () => body.promise }) as Response;
    const view = render(owner()); await waitFor(() => expect(reads).toHaveLength(1));
    transport = async () => reply(list("owner-b-token")); auth.owner = "owner-b"; view.rerender(owner());
    expect(text(await screen.findByTestId("body"))).toContain("owner-b-token");
    await act(async () => body.resolve(list("private-retired-token")));
    expect(screen.queryByText(/private-retired-token/)).toBeNull();
    expect(cache.get(unstable_serialize(["authenticated-api", "owner-a", "/v1/overlay-tokens"]))?.data).toBeUndefined();
  });
  it("blocks selector/mint/rotation for Chat drafts but permits label rename without resetting the body", async () => {
    render(owner(<Probe dirty />)); const body = await screen.findByTestId("body");
    const before = body.textContent;
    expect((screen.getByLabelText("URLs shown for") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Mint another token" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Rotate" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("URLs shown for"), { target: { value: "b" } });
    expect(body.textContent).toBe(before);
    fireEvent.change(screen.getByLabelText("Token label"), { target: { value: "Renamed" } });
    transport = async (_url, init) => init.method === "PATCH" ? reply({}) : reply(list("a", "b"));
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe("PATCH"); expect(screen.getByTestId("body").textContent).toBe(before);
  });
  it("mints a fresh credential generation for token A→B→A and rejects its retained JWT callback", async () => {
    render(owner()); await screen.findByTestId("body"); const old = heldProbe!; const first = screen.getByTestId("body").textContent;
    fireEvent.change(screen.getByLabelText("URLs shown for"), { target: { value: "b" } });
    fireEvent.change(screen.getByLabelText("URLs shown for"), { target: { value: "a" } });
    expect(screen.getByTestId("body").textContent).not.toBe(first);
    await expect(old()).rejects.toThrow("Selected token changed");
  });
  it("withholds the fresh-mint body until the returned handle is admitted by a real status read", async () => {
    render(owner()); await screen.findByTestId("body");
    const held = deferred<Response>(); transport = async (_url, init) => init.method === "POST" ? reply({ token: "fresh-handle" }) : held.promise;
    fireEvent.click(screen.getByRole("button", { name: "Mint another token" }));
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(screen.queryByTestId("body")).toBeNull();
    await act(async () => held.resolve(reply(list("a", "fresh-handle"))));
    expect(text(await screen.findByTestId("body"))).toContain("fresh-handle");
    expect(writes).toHaveLength(1);
  });
  it("keeps paused rotations visible only in the manager, never as Chat/URL bodies", async () => {
    transport = async () => reply({ items: [token("old", { revokedAt: "2026-10-26", rotationPending: true })] });
    render(owner());
    expect(await screen.findByRole("button", { name: "Continue rotation" })).toBeTruthy();
    expect(screen.queryByTestId("body")).toBeNull(); expect(writes).toEqual([]);
  });
  it("preserves known last-token DELETE 204 policy after a fresh inactive-list confirmation", async () => {
    let revoked = false, minted = false;
    transport = async (_url, init) => {
      if (init.method === "DELETE") { revoked = true; return new Response(null, { status: 204 }); }
      if (init.method === "POST") { minted = true; return reply({ token: "replacement-default" }); }
      return reply(revoked ? minted ? list("replacement-default") : list() : list("last-active"));
    };
    render(owner()); await screen.findByTestId("body");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke permanently" }));
    expect(text(await screen.findByTestId("body"))).toContain("replacement-default");
    expect(writes).toEqual([{ method: "DELETE", body: null }, { method: "POST", body: JSON.stringify({ label: "Default" }) }]);
    expect(reads).toHaveLength(3);
    expect(cache.get(unstable_serialize(["settings-streaming-create-ambiguity", "owner-a"]))).toEqual({ data: false });
  });
  it("known revocation cannot erase an older unrelated unresolved creation", async () => {
    cache.set(unstable_serialize(["settings-streaming-create-ambiguity", "owner-a"]), { data: true });
    let revoked = false;
    transport = async (_url, init) => {
      if (init.method === "DELETE") { revoked = true; return new Response(null, { status: 204 }); }
      return reply(revoked ? list() : list("last-active"));
    };
    render(owner()); await screen.findByTestId("body");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke permanently" }));
    expect(await screen.findByText(/A token change may have completed/)).toBeTruthy();
    expect(writes).toEqual([{ method: "DELETE", body: null }]); expect(reads).toHaveLength(2);
    expect(cache.get(unstable_serialize(["settings-streaming-create-ambiguity", "owner-a"]))).toMatchObject({ data: { blocked: true, generation: { mayClear: false } } });
  });
  it("rename never clears an unrelated ambiguity or retires its current body", async () => {
    cache.set(unstable_serialize(["settings-streaming-create-ambiguity", "owner-a"]), { data: true });
    transport = async (_url, init) => init.method === "PATCH" ? reply({}) : reply(list("active"));
    render(owner()); const before = (await screen.findByTestId("body")).textContent;
    fireEvent.change(screen.getByLabelText("Token label"), { target: { value: "Label only" } });
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));
    await screen.findByText("Token renamed.");
    expect(screen.getByTestId("body").textContent).toBe(before);
    expect(cache.get(unstable_serialize(["settings-streaming-create-ambiguity", "owner-a"]))).toEqual({ data: true });
    expect(writes).toHaveLength(1); expect(reads).toHaveLength(2);
  });
  it("an acknowledged explicit mint missing from its fresh list also survives remount without a default POST", async () => {
    let posted = false;
    transport = async (_url, init) => {
      if (init.method === "POST") { posted = true; return reply({ token: "not-in-status" }); }
      return reply(posted ? list() : list("active"));
    };
    const view = render(owner()); await screen.findByTestId("body");
    fireEvent.click(screen.getByRole("button", { name: "Mint another token" }));
    expect(await screen.findByText(/A token change may have completed/)).toBeTruthy();
    view.unmount(); render(owner());
    expect(await screen.findByText(/A token change may have completed/)).toBeTruthy();
    expect(writes).toHaveLength(1); expect(reads).toHaveLength(3);
  });
  it("an older instance's matching ACK cannot clear a newer same-owner cache ambiguity", async () => {
    const held = deferred<Response>(); let get = 0, post = 0;
    transport = async (_url, init) => {
      if (init.method === "POST") return reply({ token: ++post === 1 ? "first-new" : "second-new" });
      get += 1;
      return get === 3 ? held.promise : reply(get < 3 ? list("active") : list("first-new", "second-new"));
    };
    render(<Harness><div data-testid="first-owner"><SettingsStreamingTokenOwner section="setup"><Probe /></SettingsStreamingTokenOwner></div><div data-testid="second-owner"><SettingsStreamingTokenOwner section="setup"><Probe /></SettingsStreamingTokenOwner></div></Harness>);
    const first = within(screen.getByTestId("first-owner")), second = within(screen.getByTestId("second-owner"));
    await first.findByTestId("body"); await second.findByTestId("body");
    fireEvent.click(first.getByRole("button", { name: "Mint another token" }));
    await waitFor(() => expect(reads).toHaveLength(3));
    fireEvent.click(second.getByRole("button", { name: "Mint another token" }));
    expect(text(await second.findByTestId("body"))).toContain("second-new");
    const laterMarker = cache.get(unstable_serialize(["settings-streaming-create-ambiguity", "owner-a"]))!.data;
    expect(laterMarker).toMatchObject({ blocked: true, generation: { mayClear: false } });
    await act(async () => held.resolve(reply(list("first-new", "second-new"))));
    expect(text(await first.findByTestId("body"))).toContain("first-new");
    expect(cache.get(unstable_serialize(["settings-streaming-create-ambiguity", "owner-a"]))!.data).toBe(laterMarker);
    expect(writes).toHaveLength(2); expect(reads).toHaveLength(4);
  });
});
