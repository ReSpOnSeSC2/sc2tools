import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuildCard, BuildKebab } from "./BuildCard";
import { Modal } from "@/components/ui/Modal";
import type { DecoratedBuild } from "./types";
const publication = vi.hoisted(() => ({ data: undefined as undefined | { published: boolean; publicSlug: string | null; mirrorPending: boolean }, paths: [] as Array<string | null>, mutate: vi.fn(), call: vi.fn(), token: vi.fn(async () => "token") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: publication.token }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: publication.call, useApi: (path: string | null) => { publication.paths.push(path); return { data: path ? publication.data : undefined, mutate: publication.mutate }; } }));
beforeEach(() => { publication.data = undefined; publication.paths = []; publication.call.mockReset(); });

const callbacks = {
  onOpen: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onPublish: vi.fn(),
};

function build(overrides: Partial<DecoratedBuild> = {}): DecoratedBuild {
  return {
    slug: "pvt-three-gate",
    name: "PvT 3 Gate",
    race: "Protoss",
    vsRace: "Terran",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BuildCard replay-stat states", () => {
  it.each(["ready", "loading", "unavailable"] as const)("keeps valid definition groups for %s stats", statsState => {
    const stats = { name: "PvT 3 Gate", total: 8, wins: 4, losses: 4, winRate: .5, planHeldRate: .625 };
    const { container } = render(<BuildCard build={build({ stats, statsState, updatedAt: "2026-10-21T12:00:00Z" })} {...callbacks} />);
    const lists = Array.from(container.querySelectorAll("dl"));
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      for (const child of Array.from(list.children)) {
        const definitions = child.tagName === "DIV" ? Array.from(child.children) : [child];
        expect(definitions.every(item => item.tagName === "DT" || item.tagName === "DD")).toBe(true);
      }
    }
    for (const item of Array.from(container.querySelectorAll("dt, dd"))) {
      const parent = item.parentElement!;
      expect((parent.tagName === "DIV" ? parent.parentElement : parent)?.tagName).toBe("DL");
    }
  });

  it("shows a measured Held summary only for current own-perspective stats", () => {
    const stats = { name: "PvT 3 Gate", total: 8, wins: 4, losses: 4, winRate: .5, planHeldRate: 0 };
    const view = render(<BuildCard build={build({ stats, statsState: "ready" })} {...callbacks} />);
    expect(screen.getByText("Held 0%")).toBeTruthy();
    view.rerender(<BuildCard build={build({ stats: { ...stats, planHeldRate: .625 }, statsState: "ready" })} {...callbacks} />);
    expect(screen.getByText("Held 63%")).toBeTruthy();
    for (const patch of [{ statsState: "loading" as const }, { statsState: "unavailable" as const }, { perspective: "opponent" as const }]) {
      view.rerender(<BuildCard build={build({ stats, ...patch })} {...callbacks} />); expect(screen.queryByText(/Held/)).toBeNull();
    }
    view.rerender(<BuildCard build={build({ stats: { ...stats, planHeldRate: null } })} {...callbacks} />); expect(screen.queryByText(/Held/)).toBeNull();
  });
  it("does not describe an unfinished request as zero matches", () => {
    render(<BuildCard build={build({ statsState: "loading" })} {...callbacks} />);

    expect(screen.getByRole("status").textContent).toBe("Loading stats");
    expect(screen.queryByText("No classified replays")).toBeNull();
  });

  it("does not describe an API failure as zero matches", () => {
    render(
      <BuildCard build={build({ statsState: "unavailable" })} {...callbacks} />,
    );

    expect(screen.getByText("Temporarily unavailable")).toBeTruthy();
    expect(screen.queryByText("No classified replays")).toBeNull();
  });

  it("shows zero only after a successful stats response", () => {
    render(<BuildCard build={build({ statsState: "ready" })} {...callbacks} />);

    expect(screen.getByText("No classified replays")).toBeTruthy();
  });

  it("shows a single played timestamp instead of repeating the total or edited timestamp", () => {
    render(
      <BuildCard
        build={build({
          statsState: "ready",
          updatedAt: "2026-09-01T00:00:00Z",
          stats: {
            name: "PvT 3 Gate",
            wins: 300,
            losses: 276,
            total: 576,
            winRate: 300 / 576,
            lastPlayed: "2026-10-21T12:00:00Z",
          },
        })}
        {...callbacks}
      />,
    );

    expect(screen.getByText(/^Played /).getAttribute("title")).toBe(new Date("2026-10-21T12:00:00Z").toLocaleString());
    expect(screen.queryByText(/^Edited /)).toBeNull();
    expect(screen.queryByText("Total games: 576")).toBeNull();
    expect(screen.queryByText("n = 576")).toBeNull();
    expect(screen.queryByText(/check-in/)).toBeNull();
  });

  it("notes games that count only through a build check-in", () => {
    render(
      <BuildCard
        build={build({
          statsState: "ready",
          stats: {
            name: "PvT 3 Gate",
            wins: 7,
            losses: 5,
            total: 12,
            winRate: 7 / 12,
            checkins: 2,
          },
        })}
        {...callbacks}
      />,
    );

    expect(screen.getByText("incl. 2 check-ins")).toBeTruthy();
  });
});

describe("BuildCard actions menu", () => {
  it("keeps a portaled menu in its parent's Tab domain and preserves new-dialog focus on an action", async () => {
    function Host() {
      const [editing, setEditing] = useState(false);
      return <Modal open title="Parent dossier" onClose={vi.fn()}>
        <BuildKebab slug="fixture" name="Fixture" isPublic={false} onEdit={() => setEditing(true)} onPublish={vi.fn()} onDelete={vi.fn()} />
        <button>Parent end</button>
        {editing ? <Modal open title="Rich editor" onClose={() => setEditing(false)}><input aria-label="Editor field" /></Modal> : null}
      </Modal>;
    }
    render(<Host />);
    const trigger = screen.getByRole("button", { name: "Build options for Fixture" }); trigger.focus(); fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    const first = within(menu).getByRole("menuitem", { name: "Open full page" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Parent end" }));
    expect(screen.queryByRole("menu")).toBeNull();
    trigger.focus(); fireEvent.click(trigger);
    const reopened = screen.getByRole("menu");
    await waitFor(() => expect(document.activeElement).toBe(within(reopened).getByRole("menuitem", { name: "Open full page" })));
    fireEvent.click(within(reopened).getByRole("menuitem", { name: "Edit" }));
    const editor = await screen.findByRole("dialog", { name: "Rich editor" });
    const close = within(editor).getByRole("button", { name: "Close" });
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    expect(document.activeElement).toBe(close); expect(screen.queryByRole("menu")).toBeNull();
  });

  it("portals every action outside the clipped card and closes on an outside tap", () => {
    const onReclassify = vi.fn();
    render(
      <BuildCard
        build={build()}
        {...callbacks}
        onReclassify={onReclassify}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Build options for PvT 3 Gate" }),
    );

    const menu = screen.getByRole("menu", {
      name: "Build actions for PvT 3 Gate",
    });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).toContain("fixed");
    expect(menu.className).toContain("overflow-y-auto");
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Open full page", "Edit", "Practice this", "Re-match replays", "Publish…", "Delete"]);
    for (const item of screen.getAllByRole("menuitem")) {
      expect(item.className).toContain("min-h-11");
    }

    fireEvent.pointerDown(screen.getByTestId("build-menu-scrim"));

    expect(screen.queryByRole("menu", {
      name: "Build actions for PvT 3 Gate",
    })).toBeNull();
    expect(callbacks.onOpen).not.toHaveBeenCalled();
  });

  it("flips above a bottom-edge trigger, supports keyboard navigation, and restores focus", async () => {
    render(
      <BuildCard
        build={build()}
        {...callbacks}
        onReclassify={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Build options for PvT 3 Gate",
    });
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const triggerRect = vi.spyOn(trigger, "getBoundingClientRect");
    triggerRect.mockReturnValue({
      x: viewportWidth - 56,
      y: viewportHeight - 52,
      left: viewportWidth - 56,
      right: viewportWidth - 12,
      top: viewportHeight - 52,
      bottom: viewportHeight - 8,
      width: 44,
      height: 44,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", {
      name: "Build actions for PvT 3 Gate",
    });
    await waitFor(() => expect(menu.dataset.placement).toBe("top"));
    expect(Number.parseFloat(menu.style.top)).toBeLessThan(
      viewportHeight - 52,
    );
    expect(
      Number.parseFloat(menu.style.top) + Number.parseFloat(menu.style.maxHeight),
    ).toBeLessThanOrEqual(viewportHeight - 12);
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(12);
    expect(
      Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width),
    ).toBeLessThanOrEqual(viewportWidth - 12);

    triggerRect.mockReturnValue({
      x: viewportWidth - 56,
      y: 12,
      left: viewportWidth - 56,
      right: viewportWidth - 12,
      top: 12,
      bottom: 56,
      width: 44,
      height: 44,
      toJSON: () => ({}),
    });
    fireEvent.scroll(window);
    await waitFor(() => expect(menu.dataset.placement).toBe("bottom"));

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("menuitem", { name: "Open full page" }),
      );
    });
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Delete" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu", {
      name: "Build actions for PvT 3 Gate",
    })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("BuildCard variants and Community actions", () => {
  it.each([1, 4, 5, 0])("uses the low-sample cue only for one through four games (%s)", (total) => {
    const { container } = render(<BuildCard build={build({ updatedAt: "2026-10-21", stats: { name: "test", total, wins: total, losses: 0, winRate: 1 } })} {...callbacks} />);
    expect(!!screen.queryByText("Low sample")).toBe(total > 0 && total < 5);
    if (total > 0 && total < 5) expect(container.querySelector("dd")?.getAttribute("style")).toContain("--text-dim");
    expect(screen.getByText(/^Edited /)).toBeTruthy();
  });

  it("keeps duplicate private and reads public identity only when opening a public menu", () => {
    const duplicate = vi.fn();
    render(<BuildCard build={build()} {...callbacks} onDuplicate={duplicate} />);
    expect(publication.paths.filter(Boolean)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Build options for PvT 3 Gate" }));
    expect(screen.getByRole("menuitem", { name: "Open full page" }).getAttribute("href")).toBe("/builds/pvt-three-gate");
    expect(screen.queryByRole("menuitem", { name: "Unpublish" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(duplicate).toHaveBeenCalledWith("pvt-three-gate");
  });

  it("loads public links lazily, copies the public slug and unpublishes through mirror repair before refreshing", async () => {
    const changed = vi.fn();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const view = render(<BuildCard build={build({ isPublic: true })} {...callbacks} onDuplicate={vi.fn()} onChanged={changed} />);
    expect(publication.paths.filter(Boolean)).toHaveLength(0);
    const trigger = screen.getByRole("button", { name: "Build options for PvT 3 Gate" });
    fireEvent.click(trigger);
    expect((screen.getByRole("menuitem", { name: "Copy public link · Loading…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(publication.paths).toContain("/v1/community/my-build-publication/pvt-three-gate");
    publication.data = { published: true, publicSlug: "public-three-gate", mirrorPending: false };
    view.rerender(<BuildCard build={build({ isPublic: true })} {...callbacks} onDuplicate={vi.fn()} onChanged={changed} />);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open full page", "Edit", "Duplicate", "Practice this", "Update listing", "View on Community", "Copy public link", "Unpublish", "Delete"]);
    expect(screen.getByRole("menuitem", { name: "View on Community" }).getAttribute("href")).toBe("/community/builds/public-three-gate");
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy public link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/community/builds/public-three-gate`));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpublish" }));
    const dialog = screen.getByRole("dialog", { name: "Unpublish “PvT 3 Gate”?" });
    expect(dialog.textContent).toContain("Your private copy, stats and notes stay.");
    expect(publication.call).not.toHaveBeenCalled();
    publication.call.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ published: false, publicSlug: null, mirrorPending: false });
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(publication.call.mock.calls.map((call) => [call[1], call[2]?.method ?? "GET"])).toEqual([["/v1/community/builds/public-three-gate", "DELETE"], ["/v1/community/my-build-publication/pvt-three-gate", "GET"]]);
    expect(screen.getByRole("status").textContent).toBe("Unpublished.");
  });

  it("selects a read-only public link when clipboard access is blocked and keeps an Unpublish failure actionable", async () => {
    publication.data = { published: true, publicSlug: "public-three-gate", mirrorPending: false };
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => { throw new Error("blocked"); }) }, configurable: true });
    render(<BuildCard build={build({ isPublic: true })} {...callbacks} />);
    const trigger = screen.getByRole("button", { name: "Build options for PvT 3 Gate" });
    fireEvent.click(trigger); fireEvent.click(screen.getByRole("menuitem", { name: "Copy public link" }));
    const field = await screen.findByRole("textbox", { name: "Public build link" }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.readOnly).toBe(true); expect(field.selectionStart).toBe(0); expect(field.selectionEnd).toBe(field.value.length);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Copy public link" })).getByRole("button", { name: "Close" }));
    fireEvent.click(trigger); fireEvent.click(screen.getByRole("menuitem", { name: "Unpublish" }));
    publication.call.mockRejectedValue({ message: "Service unavailable", requestId: "req-unpublish" });
    const dialog = screen.getByRole("dialog", { name: "Unpublish “PvT 3 Gate”?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Service unavailable Error ID: req-unpublish"));
    expect(screen.getByRole("dialog", { name: "Unpublish “PvT 3 Gate”?" })).toBe(dialog);
    expect((within(dialog).getByRole("button", { name: "Unpublish" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports a committed removal honestly when only the private badge refresh fails", async () => {
    publication.data = { published: true, publicSlug: "public-three-gate", mirrorPending: false };
    publication.call.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce({ message: "Badge offline", requestId: "req-badge" });
    const changed = vi.fn();
    render(<BuildCard build={build({ isPublic: true })} {...callbacks} onChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Build options for PvT 3 Gate" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpublish" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Unpublish “PvT 3 Gate”?" })).getByRole("button", { name: "Unpublish" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("The listing is unpublished, but its private badge couldn't refresh.");
    expect(screen.getByRole("status").textContent).toContain("req-badge");
  });
});
