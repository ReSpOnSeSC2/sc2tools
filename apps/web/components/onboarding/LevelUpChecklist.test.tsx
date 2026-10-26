import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode } from "react";
import { SWRConfig, useSWRConfig, unstable_serialize } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVATION_PATH, type ActivationResponse } from "@/lib/activation";
import { ToastProvider } from "@/components/ui/Toast";
import { LevelUpChecklist } from "./LevelUpChecklist";

const auth = vi.hoisted(() => ({ owner: "owner-a" as string | null, loaded: true, getToken: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: auth.owner, isLoaded: auth.loaded, isSignedIn: !!auth.owner, getToken: auth.getToken }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ slug, children }: { slug: string; children: ReactNode }) => <a href={`/help/${slug}`}>{children}</a> }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const answer = (extra: Partial<ActivationResponse> = {}): ActivationResponse => ({ identity: false, firstGameViewed: false, customBuild: false, checkIn: false, overlayLive: false, chatOn: false, goals: [], levelUpDismissedAt: null, ...extra });
let cache: Map<string, { data?: unknown }>;
let refresh: ReturnType<typeof useSWRConfig>["mutate"];
let values: Map<string, ActivationResponse>;
let reads: string[];
let writes: { owner: string; body: Record<string, unknown> }[];
let get: (owner: string) => Promise<Response>;
let put: (owner: string, body: Record<string, unknown>) => Promise<Response>;
function Harness() { refresh = useSWRConfig().mutate; return <ToastProvider><LevelUpChecklist /></ToastProvider>; }
function ui() { return <SWRConfig value={{ provider: () => cache, revalidateOnFocus: false, revalidateOnReconnect: false }}><Harness /></SWRConfig>; }
const revalidate = () => act(async () => { await refresh(["authenticated-api", auth.owner, ACTIVATION_PATH]); });
beforeEach(() => {
  auth.owner = "owner-a"; auth.loaded = true; auth.getToken.mockReset().mockImplementation(async () => `jwt-${auth.owner}`);
  cache = new Map(); values = new Map([["owner-a", answer()], ["owner-b", answer({ goals: ["stream"] })]]); reads = []; writes = [];
  get = async owner => reply(values.get(owner) ?? null); put = async (_owner, body) => reply(body);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const owner = String((init.headers as Record<string, string>)?.authorization).replace("Bearer jwt-", "");
    const path = new URL(String(input)).pathname;
    if ((init.method ?? "GET") === "GET" && path === ACTIVATION_PATH) { reads.push(owner); return get(owner); }
    if (init.method === "PUT" && path === "/v1/me/preferences/onboarding") { const body = JSON.parse(String(init.body)); writes.push({ owner, body }); return put(owner, body); }
    throw new Error(`Unexpected request ${init.method ?? "GET"} ${path}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Today feature suggestions", () => {
  it.each([["improve", 4, "Create a build"], ["stream", 4, "Connect an overlay link"], ["both", 6, "Create a build"]] as const)("shows the selected %s steps with accessible progress and real destinations", async (goal, total, title) => {
    values.set("owner-a", answer({ goals: goal === "both" ? [] : [goal as "improve" | "stream"] }));
    render(ui()); const card = await screen.findByTestId("level-up-checklist");
    await within(card).findByRole("heading", { name: `${title}, not yet tried` });
    expect(within(card).getAllByRole("listitem")).toHaveLength(total);
    expect(within(card).getByRole("progressbar").getAttribute("aria-valuemax")).toBe(String(total));
    expect(within(card).getByRole("link", { name: "Your first week" }).getAttribute("href")).toBe("/help/your-first-week");
    expect(within(card).getByRole("link", { name: "Browse replays" }).getAttribute("href")).toBe("/app/replays");
    expect(reads).toEqual(["owner-a"]); expect(writes).toEqual([]);
  });
  it("does not toast for initially complete data, and toasts only observed completion transitions", async () => {
    const complete = answer({ identity: true, firstGameViewed: true, customBuild: true, checkIn: true, overlayLive: true, chatOn: true });
    values.set("owner-a", complete); const view = render(ui());
    await screen.findByRole("link", { name: "see What's new" }); expect(screen.queryByText("Your suggested SC2 Tools features are ready to use.")).toBeNull();
    values.set("owner-a", { ...complete, checkIn: false }); await revalidate();
    await screen.findByRole("heading", { name: "Check in a build, not yet tried" });
    values.set("owner-a", complete); await revalidate();
    expect(await screen.findAllByText("Your suggested SC2 Tools features are ready to use.")).toHaveLength(1);
    await revalidate(); view.rerender(ui()); expect(screen.getAllByText("Your suggested SC2 Tools features are ready to use.")).toHaveLength(1);
  });
  it("waits for dismissal ACK and changes only the independent dismissal field", async () => {
    const held = deferred<Response>(); put = () => held.promise; render(ui());
    const button = await screen.findByRole("button", { name: "Dismiss suggestions" }); fireEvent.click(button);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(screen.getByRole("heading", { name: "Get more out of SC2 Tools" })).toBeTruthy();
    expect(Object.keys(writes[0].body)).toEqual(["levelUpDismissedAt"]);
    expect(Number.isFinite(Date.parse(String(writes[0].body.levelUpDismissedAt)))).toBe(true);
    await act(async () => held.resolve(reply(writes[0].body)));
    await waitFor(() => expect(screen.queryByTestId("level-up-checklist")).toBeNull());
    expect(reads).toHaveLength(1); expect(writes).toHaveLength(1);
  });
  it("also lets the owner dismiss the completed compact card without a completion toast", async () => {
    values.set("owner-a", answer({ identity: true, firstGameViewed: true, customBuild: true, checkIn: true, overlayLive: true, chatOn: true }));
    render(ui()); await screen.findByRole("link", { name: "see What's new" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestions" }));
    await waitFor(() => expect(screen.queryByTestId("level-up-checklist")).toBeNull());
    expect(Object.keys(writes[0].body)).toEqual(["levelUpDismissedAt"]);
    expect(screen.queryByText("Your suggested SC2 Tools features are ready to use.")).toBeNull();
  });
  it("keeps failed dismissal visible with an explicit narrow retry", async () => {
    put = vi.fn().mockResolvedValueOnce(reply({ error: { code: "unavailable" } }, 503)).mockImplementation(async (_owner, body) => reply(body));
    render(ui()); fireEvent.click(await screen.findByRole("button", { name: "Dismiss suggestions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByTestId("level-up-checklist")).toBeNull());
    expect(writes).toHaveLength(2); expect(reads).toHaveLength(1);
  });
  it("does not hide or patch progress for a malformed or stale successful dismissal body", async () => {
    put = async () => reply({ levelUpDismissedAt: "2020-01-01T00:00:00.000Z", dismissedAt: "unrelated setup dismissal" });
    render(ui()); fireEvent.click(await screen.findByRole("button", { name: "Dismiss suggestions" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: "Get more out of SC2 Tools" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss suggestions" })).toBeTruthy();
    expect((cache.get(unstable_serialize(["authenticated-api", "owner-a", ACTIVATION_PATH]))?.data as ActivationResponse).levelUpDismissedAt).toBeNull();
    expect(reads).toHaveLength(1); expect(writes).toHaveLength(1);
  });
  it("retires a held dismissal body across owner A→B→A without hiding the new card or patching its cache", async () => {
    const held = deferred<Record<string, unknown>>(); put = async () => ({ ok: true, status: 200, json: () => held.promise }) as Response;
    const view = render(ui()); fireEvent.click(await screen.findByRole("button", { name: "Dismiss suggestions" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    auth.owner = "owner-b"; view.rerender(ui()); await screen.findByRole("heading", { name: "Enable a chat platform, not yet tried" });
    auth.owner = "owner-a"; view.rerender(ui()); await screen.findByRole("heading", { name: "Create a build, not yet tried" });
    await act(async () => held.resolve(writes[0].body));
    expect(screen.getByRole("button", { name: "Dismiss suggestions" })).toBeTruthy();
    expect((cache.get(unstable_serialize(["authenticated-api", "owner-a", ACTIVATION_PATH]))?.data as ActivationResponse).levelUpDismissedAt).toBeNull();
    expect(screen.queryByText("Your suggested SC2 Tools features are ready to use.")).toBeNull();
  });
  it("does not dispatch a held dismissal JWT after owner retirement", async () => {
    const held = deferred<string>(); render(ui()); const button = await screen.findByRole("button", { name: "Dismiss suggestions" });
    auth.getToken.mockImplementationOnce(() => held.promise); fireEvent.click(button);
    await waitFor(() => expect(auth.getToken).toHaveBeenCalledTimes(2));
    auth.owner = "owner-b"; cleanup(); render(ui()); await screen.findByRole("heading", { name: "Enable a chat platform, not yet tried" });
    await act(async () => held.resolve("jwt-owner-a")); expect(writes).toEqual([]);
  });
  it("waits while signed out or auth is loading, and honors saved independent dismissal", async () => {
    auth.loaded = false; const view = render(ui()); await act(async () => {}); expect(reads).toEqual([]);
    auth.loaded = true; auth.owner = null; view.rerender(ui()); await act(async () => {}); expect(reads).toEqual([]);
    auth.owner = "owner-a"; values.set("owner-a", answer({ levelUpDismissedAt: "2026-10-26T12:00:00.000Z" })); view.rerender(ui());
    await waitFor(() => expect(reads).toHaveLength(1)); await waitFor(() => expect(screen.queryByTestId("level-up-checklist")).toBeNull());
  });
  it("shows honest unavailable and malformed response states without a fabricated six-tuple", async () => {
    get = vi.fn().mockResolvedValueOnce(reply({ error: { code: "activation_unavailable" } }, 503)).mockResolvedValueOnce(reply(null)).mockImplementation(async owner => reply(values.get(owner)));
    render(ui());
    expect(await screen.findByRole("alert")).toBeTruthy(); expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); await waitFor(() => expect(reads).toHaveLength(2));
    expect(await screen.findByRole("alert")).toBeTruthy(); expect(screen.queryByRole("progressbar")).toBeNull();
    values.set("owner-a", answer({ goals: ["improve"] })); fireEvent.click(await screen.findByRole("button", { name: "Retry", exact: true }));
    await screen.findByRole("heading", { name: "Create a build, not yet tried" }); expect(writes).toEqual([]);
  });
});
