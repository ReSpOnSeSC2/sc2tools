import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { ToastProvider } from "@/components/ui/Toast";
import { ShareGameButton } from "../ShareGameButton";
import gamePageHelp from "@/lib/help/articles/game-page/game-page";
import sharingHelp from "@/lib/help/articles/game-page/game-page-sharing";
import type { GameSummary } from "../types";

/**
 * The game's Share menu: a keyboard-operable menu of share rows. The
 * battle card goes through the shared delivery pipeline, a delivered card
 * is counted once by path, a dismissed share sheet is neither counted nor
 * announced, and the share link is created on first use and copied.
 */

const mocks = vi.hoisted(() => ({
  renderBattleCardPng: vi.fn(),
  deliverShareCard: vi.fn(),
  trackCardShared: vi.fn(),
  fetch: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "owner", isLoaded: true, isSignedIn: true, getToken: async () => "owner-token" }) }));
vi.mock("@/lib/battleCard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/battleCard")>()),
  renderBattleCardPng: mocks.renderBattleCardPng,
}));
vi.mock("@/components/analyzer/arcade/ShareCard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/analyzer/arcade/ShareCard")>()),
  deliverShareCard: mocks.deliverShareCard,
}));
vi.mock("@/lib/analytics/shareEvents", () => ({ trackCardShared: mocks.trackCardShared }));

const GAME: GameSummary = {
  gameId: "2026-11-01T20:00:00|SecretFoe#1234|Alcyone LE|700",
  result: "Victory",
  map: "Alcyone LE",
  myRace: "Protoss",
  myBuild: "PvZ - Stargate Opener",
  myMmr: 4100,
  opponent: {
    displayName: "SecretFoe#1234",
    pulseId: "1-S2-1-9988776",
    race: "Zerg",
    mmr: 4237,
    strategy: "Zerg - Roach Push",
  },
};
const REFERENCE_PATH = "/v1/me/replay-sharing/reference";
const REFERENCE = "r-0123456789abcdef01234567";
const SHARES = `/v1/games/${encodeURIComponent(GAME.gameId)}/shares`;
const TOKEN = "AbCdEfGhIjKlMnOp";
const share = (active = true) => ({ token: TOKEN, gameId: GAME.gameId, url: `/g/${TOKEN}`, active, createdAt: "2026-11-10T10:00:00Z", revokedAt: null, viewCount: 3, lastViewedAt: null });

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  mocks.renderBattleCardPng.mockReset().mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  mocks.deliverShareCard.mockReset();
  mocks.trackCardShared.mockReset();
  mocks.writeText.mockReset().mockResolvedValue(undefined);
  mocks.fetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith(SHARES) && (init?.method ?? "GET") === "GET") return json({ shares: [], activeCount: 0, limit: 200 });
    if (String(url).endsWith(SHARES) && init?.method === "POST") return json({ share: share(), created: true }, 201);
    if (String(url).endsWith(REFERENCE_PATH) && init?.method === "POST") return json({ reference: REFERENCE });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", mocks.fetch);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.writeText } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(props: Partial<Parameters<typeof ShareGameButton>[0]> = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ToastProvider>
        <ShareGameButton game={GAME} {...props} />
      </ToastProvider>
    </SWRConfig>,
  );
}
/** Answer the replay-sharing read (or fail it with a status) and record PUTs. */
function replaySharing(answer: { enabled: boolean; handle: string | null } | number, reference?: Response) {
  const base = mocks.fetch.getMockImplementation()!;
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (reference && String(url).endsWith(REFERENCE_PATH) && init?.method === "POST") return reference;
    if (!String(url).endsWith("/v1/me/replay-sharing")) return base(url, init);
    if (init?.method === "PUT") return json({ enabled: true, handle: "bob", updatedAt: "2026-11-10T12:00:00Z" });
    return typeof answer === "number" ? json({ error: { code: "auth_required" } }, answer) : json({ ...answer, updatedAt: null });
  });
}
const PUBLIC_URL = `${window.location.origin}/players/bob/replays/${REFERENCE}`;
const trigger = () => screen.getByRole("button", { name: "Share" });
function openMenu() {
  fireEvent.click(trigger());
  return screen.getByRole("menu", { name: "Share" });
}
function chooseImage() {
  mount();
  fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /Save battle card image/ }));
}

describe("ShareGameButton menu", () => {
  it("is a labelled menu button whose rows are menu items", () => {
    mount();
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    const menu = openMenu();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Copy link to this game"),
      expect.stringContaining("Save battle card image"),
      expect.stringContaining("Copy share link"),
      expect.stringContaining("Manage share links"),
      expect.stringContaining("How sharing works"),
    ]);
    expect(within(menu).getByRole("menuitem", { name: /How sharing works/ }).getAttribute("href")).toBe("/help/game-page-sharing");
  });

  it("moves with the arrow, Home and End keys, and Escape returns focus to the trigger", () => {
    mount();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("opens on ArrowUp at the last row and closes on an outside click", () => {
    mount();
    fireEvent.keyDown(trigger(), { key: "ArrowUp" });
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("creates the share link on first use and copies its public address", async () => {
    mount();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /Copy share link/ }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(`${window.location.origin}/g/${TOKEN}`));
    const post = mocks.fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(String(post?.[0])).toContain(SHARES);
    expect(await screen.findByText("Link copied")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("copies an existing live link without creating another", async () => {
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) =>
      String(url).endsWith(SHARES) && (init?.method ?? "GET") === "GET" ? json({ shares: [share()], activeCount: 1, limit: 200 }) : json({}, 500));
    mount();
    const menu = openMenu();
    expect(await within(menu).findByText(/Your live link, opened 3 times/)).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Copy share link/ }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(`${window.location.origin}/g/${TOKEN}`));
    expect(mocks.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("shows the link in a manual-copy dialog when the clipboard refuses", async () => {
    mocks.writeText.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    mount();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /Copy share link/ }));
    const field = await screen.findByLabelText("Link to copy");
    expect((field as HTMLInputElement).value).toBe(`${window.location.origin}/g/${TOKEN}`);
    expect(screen.queryByText("Link copied")).toBeNull();
  });

  it("manages links: lists the live link with its views and turns it off", async () => {
    let revoked = false;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { revoked = true; return json({ share: share(false) }); }
      if (String(url).endsWith(SHARES)) return json({ shares: [share(!revoked)], activeCount: revoked ? 0 : 1, limit: 200 });
      return json({}, 404);
    });
    mount();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /Manage share links/ }));
    const dialog = await screen.findByRole("dialog", { name: "Share links for this game" });
    expect(await within(dialog).findByText(`${window.location.origin}/g/${TOKEN}`)).toBeTruthy();
    expect(within(dialog).getByText(/3 views/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn off link" }));
    await waitFor(() => expect(mocks.fetch.mock.calls.some(([u, init]) => init?.method === "DELETE" && String(u).endsWith(`/v1/shares/${TOKEN}`))).toBe(true));
    expect(await within(dialog).findByText("This game has no live share link.")).toBeTruthy();
  });

  it("copies a link at the shared clock time, hidden under one second", async () => {
    const view = mount({ currentTimeSec: 522.7 });
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /Copy link at 8:42/ }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(`${window.location.origin}/app/game/${encodeURIComponent(GAME.gameId)}?t=522`));
    view.unmount();
    mount({ currentTimeSec: 0.5 });
    expect(within(openMenu()).queryByRole("menuitem", { name: /Copy link at/ })).toBeNull();
  });

  it("copies the owner-only link to the game", async () => {
    mount();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /Copy link to this game/ }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(`${window.location.origin}/app/game/${encodeURIComponent(GAME.gameId)}`));
  });

  it("copies the exact public replay address while public replays are on", async () => {
    replaySharing({ enabled: true, handle: "bob" });
    mount();
    fireEvent.click(await within(openMenu()).findByRole("menuitem", { name: /Copy public link/ }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(PUBLIC_URL));
    const post = mocks.fetch.mock.calls.find(([url, init]) => String(url).endsWith(REFERENCE_PATH) && init?.method === "POST");
    expect(String(post?.[0])).not.toContain("SecretFoe");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ gameId: GAME.gameId });
    expect(mocks.fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("asks before turning public replays on, then writes and copies the public link", async () => {
    replaySharing({ enabled: false, handle: null });
    mount();
    fireEvent.click(await within(openMenu()).findByRole("menuitem", { name: /Turn on public replays/ }));
    const dialog = await screen.findByRole("dialog", { name: "Turn on public replays?" });
    expect(within(dialog).getByText(/Exactly what visitors can see/)).toBeTruthy();
    expect(within(dialog).getByText(/archive and analysis keep opponents anonymous/)).toBeTruthy();
    expect(within(dialog).getByText(/files can contain player names, account identifiers, chat/)).toBeTruthy();
    expect(within(dialog).getByText(/disable the page, analysis access, and new downloads/)).toBeTruthy();
    expect(mocks.fetch.mock.calls.some(([, init]) => ["POST", "PUT"].includes(init?.method ?? ""))).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on and copy link" }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(PUBLIC_URL));
    const writes = mocks.fetch.mock.calls.filter(([, init]) => ["POST", "PUT"].includes(init?.method ?? ""));
    expect(writes.map(([url, init]) => [new URL(String(url)).pathname, init?.method])).toEqual([
      [REFERENCE_PATH, "POST"],
      ["/v1/me/replay-sharing", "PUT"],
    ]);
    expect(JSON.parse(String(writes[1][1]?.body))).toEqual({ enabled: true });
    expect(await screen.findByText("Public replay page is live. Link copied.")).toBeTruthy();
  });

  it.each([true, false])("fails closed if the reference cannot be verified (sharing enabled: %s)", async (enabled) => {
    replaySharing({ enabled, handle: enabled ? "bob" : null }, json({ reference: GAME.gameId }));
    mount();
    const menu = within(openMenu());
    fireEvent.click(await menu.findByRole("menuitem", { name: enabled ? /Copy public link/ : /Turn on public replays/ }));
    if (!enabled) {
      const dialog = await screen.findByRole("dialog", { name: "Turn on public replays?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Turn on and copy link" }));
    }
    expect(await screen.findByText("Couldn't copy a public replay link")).toBeTruthy();
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it.each([
    ["an excluded game", { enabled: true, handle: "bob" } as const, { ...GAME, excluded: true }],
    ["a resumed game", { enabled: true, handle: "bob" } as const, { ...GAME, isResumedFromReplay: true }],
    ["an unreadable sharing status", 401, GAME],
  ])("hides the public rows for %s and keeps the others", async (_case, answer, game) => {
    replaySharing(answer);
    mount({ game });
    const menu = openMenu();
    await waitFor(() => expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith("/v1/me/replay-sharing"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(menu).queryByRole("menuitem", { name: /public/i })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /Copy link to this game/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Save battle card image/ })).toBeTruthy();
  });

  it("reports a link that could not be created", async () => {
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? json({ error: { code: "share_limit", message: "You can have at most 200 active share links." } }, 409)
      : json({ shares: [], activeCount: 200, limit: 200 }));
    mount();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /Copy share link/ }));
    expect(await screen.findByText("Couldn't create a share link")).toBeTruthy();
    expect(mocks.writeText).not.toHaveBeenCalled();
  });
});

describe("Help", () => {
  it("documents every menu row at game-page#sharing and links the full sharing article", () => {
    const at = gamePageHelp.body.findIndex((block) => block.type === "heading" && block.anchor === "sharing");
    expect(at).toBeGreaterThan(-1);
    const section = JSON.stringify(gamePageHelp.body.slice(at, at + 3));
    for (const row of ["Copy link at m:ss", "Copy link to this game", "Copy public link", "Turn on public replays", "Copy share link", "Save battle card image", "/help/game-page-sharing"]) {
      expect(section).toContain(row);
    }
    expect(section).toMatch(/signs in to see its analysis/);
    expect(section).toMatch(/private notes are never shown/);
    expect(sharingHelp.slug).toBe("game-page-sharing");
  });
});

describe("Save battle card image", () => {
  it("sends text that carries no opponent name, id or exact rating", async () => {
    mocks.deliverShareCard.mockResolvedValue({ shared: true, method: "web_share" });
    chooseImage();
    await waitFor(() => expect(mocks.deliverShareCard).toHaveBeenCalledTimes(1));

    expect(mocks.renderBattleCardPng).toHaveBeenCalledWith(GAME);
    const delivery = mocks.deliverShareCard.mock.calls[0][0];
    expect(delivery.title).toBe("SC2 Battle Card");
    expect(delivery.filename).toBe("sc2-pvz-victory.png");
    expect(delivery.text).toContain("Victory — PvZ on Alcyone LE");
    expect(delivery.text).toContain("MMR 4100 · opponent about 100 higher");
    for (const secret of ["SecretFoe", "9988776", "4237", "137"]) {
      expect(`${delivery.text}\n${delivery.filename}`).not.toContain(secret);
    }
  });

  it.each([
    ["web_share", "Battle card shared"],
    ["clipboard_image", "Battle card copied"],
    ["clipboard_text", "Battle card copied"],
    ["download", "Battle card saved"],
  ] as const)("counts a card delivered by %s and says so", async (method, toast) => {
    mocks.deliverShareCard.mockResolvedValue({ shared: true, method });
    chooseImage();

    expect(await screen.findByText(toast)).toBeTruthy();
    expect(mocks.trackCardShared).toHaveBeenCalledTimes(1);
    expect(mocks.trackCardShared).toHaveBeenCalledWith({ card: "battle_card", method });
  });

  it("neither counts nor announces a dismissed share sheet", async () => {
    mocks.deliverShareCard.mockResolvedValue({ shared: false, method: null });
    chooseImage();
    await waitFor(() => expect(mocks.deliverShareCard).toHaveBeenCalledTimes(1));

    // The row comes back to life once the attempt is over.
    fireEvent.click(trigger());
    await waitFor(() =>
      expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Save battle card image/ }).getAttribute("aria-disabled")).toBeNull(),
    );
    expect(mocks.trackCardShared).not.toHaveBeenCalled();
    expect(screen.queryByText(/Battle card (shared|copied|saved)/)).toBeNull();
    expect(screen.queryByText("Share failed")).toBeNull();
  });

  it("reports a card that could not be drawn, without counting it", async () => {
    mocks.renderBattleCardPng.mockResolvedValue(null);
    chooseImage();

    expect(await screen.findByText("Couldn't render the battle card")).toBeTruthy();
    expect(mocks.deliverShareCard).not.toHaveBeenCalled();
    expect(mocks.trackCardShared).not.toHaveBeenCalled();
  });
});
