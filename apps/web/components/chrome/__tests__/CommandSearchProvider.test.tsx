import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSearchItem } from "@/lib/commandSearch";
import { COMMAND_SEARCH_RECENT_KEY } from "@/lib/commandSearchRecent";
import type { SettingsTabId } from "@/lib/settingsRegistry";
import { SettingsShell } from "@/components/analyzer/settings/SettingsShell";
import { usePublishDirty } from "@/components/analyzer/settings/SettingsContext";
import { CommandSearchProvider, type CommandFrame } from "../CommandSearchProvider";
import {
  useCommandChrome, useCommandSearch, useCommandSettings,
  type CommandNavigation, type CommandOpening, type CommandSearchContextValue,
} from "../CommandSearchContext";

type RuntimeProps = {
  frame: CommandFrame; navigation: readonly CommandNavigation[]; settingsTabs?: readonly SettingsTabId[];
  onClose: () => void; onSelect: (item: CommandSearchItem) => void;
};
const fixture = vi.hoisted(() => ({
  path: "/app", viewer: "user_a", signedIn: true, loaded: true, push: vi.fn(),
  loads: 0, runtime: [] as RuntimeProps[], opens: [] as CommandSearchContextValue["open"][],
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({
  userId: fixture.viewer, isSignedIn: fixture.signedIn, isLoaded: fixture.loaded,
}) }));
vi.mock("next/navigation", () => {
  const router = { push: fixture.push };
  return { usePathname: () => fixture.path, useRouter: () => router };
});
// Only the lazy heavy boundary is replaced; admission/registrations/shortcuts/recents stay real.
vi.mock("../CommandSearchRuntime", () => {
  fixture.loads++;
  return { default: function RuntimeBoundary(props: RuntimeProps) {
    fixture.runtime.push(props);
    return <section role="dialog" aria-label="Runtime boundary" data-frame={props.frame.id}
      data-mode={props.frame.mode} data-query={props.frame.query ?? ""}>
      <button type="button" onClick={props.onClose}>Close runtime</button>
    </section>;
  } };
});

const navigation: readonly CommandNavigation[] = [
  { key: "today", href: "/app", label: "Today" },
  { key: "opponents", href: "/app/opponents", label: "Opponents" },
  { key: "settings", href: "/settings", label: "Settings" },
];
const settingsItem: CommandSearchItem = {
  id: "settings:chat-tts", group: "settings", label: "Text-to-speech", href: "/settings?tab=chat#tts",
};
const opponentsItem: CommandSearchItem = {
  id: "navigation:opponents", group: "navigation", label: "Opponents", href: "/app/opponents",
};
const noGuard = () => {};

function Host({ entries, guard }: { entries: readonly CommandNavigation[]; guard: (href: string) => void }) {
  const context = useCommandSearch()!;
  const chrome = useMemo(() => ({ ownerKey: context.ownerKey, navigation: entries }), [context.ownerKey, entries]);
  const settings = useMemo(() => ({ ownerKey: context.ownerKey, tabs: ["chat"] as const, navigate: guard }),
    [context.ownerKey, guard]);
  useCommandChrome(chrome); useCommandSettings(settings);
  useLayoutEffect(() => { fixture.opens.push(context.open); }, [context.open]);
  return <button type="button" onClick={() => context.open()}>Open provider search</button>;
}

function tree(entries = navigation, guard: (href: string) => void = noGuard) {
  return <CommandSearchProvider><Host entries={entries} guard={guard} /></CommandSearchProvider>;
}

function path(value: string) {
  fixture.path = value; window.history.replaceState(null, "", value);
}

async function open(options?: CommandOpening): Promise<RuntimeProps> {
  act(() => fixture.opens.at(-1)!(options));
  await screen.findByRole("dialog", { name: "Runtime boundary" });
  return fixture.runtime.at(-1)!;
}

function expectFrame(frame: CommandFrame) {
  expect(screen.getByRole("dialog", { name: "Runtime boundary" }).getAttribute("data-frame")).toBe(String(frame.id));
  expect(fixture.runtime.at(-1)!.frame).toBe(frame);
}

function Draft({ id }: { id: SettingsTabId }) {
  const [value, setValue] = useState("saved"); usePublishDirty(id, value !== "saved");
  return <input aria-label={`${id} draft`} value={value} onChange={event => setValue(event.target.value)} />;
}

function ActualSettingsHost() {
  const context = useCommandSearch()!;
  const chrome = useMemo(() => ({ ownerKey: context.ownerKey, navigation }), [context.ownerKey]);
  useCommandChrome(chrome);
  useLayoutEffect(() => { fixture.opens.push(context.open); }, [context.open]);
  return <><button type="button" onClick={() => context.open()}>Open provider search</button>
    <SettingsShell ownerKey={context.ownerKey} initialTab="profile" renderTab={id => <Draft id={id} />} /></>;
}

beforeEach(() => {
  fixture.viewer = "user_a"; fixture.signedIn = true; fixture.loaded = true;
  fixture.runtime.length = 0; fixture.opens.length = 0; fixture.push.mockClear();
  path("/app"); localStorage.clear();
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("actual provider lazy boundary", () => {
  it("does not import the heavy runtime before an explicit opening", async () => {
    expect(fixture.loads).toBe(0);
    render(tree());
    expect(fixture.loads).toBe(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    const current = await open({ query: "TTS", scope: "all" });
    expect(fixture.loads).toBe(1);
    expect(current.frame.query).toBe("TTS");
    expect(current.navigation).toEqual(navigation);
  });

  it("records only exact admitted static routes, never a dossier URL or query", () => {
    const view = render(tree());
    expect(JSON.parse(localStorage.getItem(COMMAND_SEARCH_RECENT_KEY)!).ids).toEqual(["today"]);
    path("/app/opponents/1-S2-1-private"); view.rerender(tree());
    const raw = localStorage.getItem(COMMAND_SEARCH_RECENT_KEY)!;
    expect(JSON.parse(raw).ids).toEqual(["today"]);
    expect(raw).not.toContain("1-S2-1-private");
  });
});

describe("owner and route lifetimes", () => {
  it("retires owner A callbacks through A-B-A without replacing a newer frame", async () => {
    const view = render(tree()), oldOpen = fixture.opens.at(-1)!;
    const old = await open({ query: "old A" });
    fixture.viewer = "user_b"; view.rerender(tree());
    expect(screen.queryByRole("dialog")).toBeNull();
    const currentB = await open({ query: "current B" });
    act(() => { oldOpen({ query: "stale" }); old.onSelect(opponentsItem); });
    expectFrame(currentB.frame);
    fixture.viewer = "user_a"; view.rerender(tree());
    const currentA = await open({ query: "new A" });
    act(() => { oldOpen({ query: "stale again" }); old.onSelect(opponentsItem); old.onClose(); });
    expectFrame(currentA.frame);
    expect(fixture.push).not.toHaveBeenCalled();
    act(() => currentA.onSelect(opponentsItem));
    expect(fixture.push).toHaveBeenCalledTimes(1);
    expect(fixture.push).toHaveBeenCalledWith("/app/opponents");
  });

  it("does not resurrect an old route A frame or accept its callbacks after A-B-A", async () => {
    const view = render(tree()), oldOpen = fixture.opens.at(-1)!;
    const old = await open({ query: "old route" });
    path("/app/opponents"); view.rerender(tree());
    expect(screen.queryByRole("dialog")).toBeNull();
    path("/app"); view.rerender(tree());
    expect(screen.queryByRole("dialog")).toBeNull();
    const current = await open({ query: "new route" });
    act(() => { oldOpen(); old.onSelect(opponentsItem); old.onClose(); });
    expectFrame(current.frame);
    expect(fixture.push).not.toHaveBeenCalled();
  });
});

describe("handoff admission", () => {
  it.each(["owner", "route"])("cancels a queued selection when %s changes before its effect", async change => {
    const view = render(tree()), old = await open();
    act(() => {
      old.onSelect(opponentsItem);
      if (change === "owner") fixture.viewer = "user_b";
      else path("/app/opponents");
      view.rerender(tree());
    });
    expect(fixture.push).not.toHaveBeenCalled();
    fixture.viewer = "user_a"; path("/app"); view.rerender(tree());
    await open({ query: "fresh" });
    expect(fixture.push).not.toHaveBeenCalled();
  });

  it("rechecks the current role-gated navigation before admitting an older result", async () => {
    const admin = { key: "admin", href: "/admin", label: "Admin" };
    const view = render(tree([...navigation, admin])), old = await open();
    view.rerender(tree(navigation));
    act(() => old.onSelect({ id: "navigation:admin", group: "navigation", label: "Admin", href: "/admin" }));
    expect(fixture.push).not.toHaveBeenCalled();
    view.rerender(tree([...navigation, admin]));
    const fresh = await open();
    act(() => old.onSelect(opponentsItem));
    expectFrame(fresh.frame);
  });

  it("uses the committed current Settings navigator for retained selections and external targets", async () => {
    path("/settings");
    const before = vi.fn(), current = vi.fn(), view = render(tree(navigation, before)), old = await open();
    view.rerender(tree(navigation, current));
    act(() => old.onSelect(settingsItem));
    expect(before).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledWith("/settings?tab=chat#tts");
    expect(fixture.push).not.toHaveBeenCalled();
    const next = await open();
    act(() => next.onSelect(opponentsItem));
    expect(current).toHaveBeenLastCalledWith("/app/opponents");
    expect(fixture.push).not.toHaveBeenCalled();
  });
});

describe("retirement and action handoff", () => {
  it.each(["popstate", "hashchange"])("retires a frame on same-path %s and rejects its late selection", async kind => {
    render(tree()); const old = await open();
    act(() => window.dispatchEvent(new Event(kind)));
    expect(screen.queryByRole("dialog")).toBeNull();
    const current = await open();
    act(() => old.onSelect(opponentsItem));
    expectFrame(current.frame);
    expect(fixture.push).not.toHaveBeenCalled();
  });

  it("hands a closed palette to an action frame while retaining its persistent return target", async () => {
    render(tree());
    const trigger = screen.getByRole("button", { name: "Open provider search" });
    trigger.focus(); const old = await open({ returnFocus: trigger });
    act(() => old.onSelect({ id: "action:theme", group: "actions", label: "Appearance", action: "toggle-theme" }));
    await waitFor(() => expect(fixture.runtime.at(-1)!.frame.mode).toBe("theme"));
    expect(fixture.runtime.at(-1)!.frame.id).not.toBe(old.frame.id);
    expect(fixture.runtime.at(-1)!.frame.returnFocus).toBe(trigger);
  });

  it("removes its keyboard owner and cannot revive a runtime after unmount", async () => {
    const view = render(tree()), retired = fixture.opens.at(-1)!;
    const old = await open(); view.unmount();
    act(() => { retired(); old.onSelect(opponentsItem); });
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fixture.push).not.toHaveBeenCalled();
  });
});

describe("actual SettingsShell command guard", () => {
  it.each(["settings", "external"])("guards %s selection with current dirty Stay/Discard semantics", async kind => {
    path("/settings"); window.history.replaceState(null, "", "/settings?tab=profile&ref=keep#pulse-ids");
    render(<CommandSearchProvider><ActualSettingsHost /></CommandSearchProvider>);
    const draft = screen.getByRole("textbox", { name: "profile draft" }), beforeHref = window.location.href;
    const old = await open();
    // The retained palette selection must consult the Shell's newly committed dirty closure.
    fireEvent.change(draft, { target: { value: "unsaved current draft" } });
    const target = kind === "settings" ? settingsItem : opponentsItem;
    act(() => old.onSelect(target));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    expect(fixture.push).not.toHaveBeenCalled(); expect(window.location.href).toBe(beforeHref);
    fireEvent.click(screen.getByRole("button", { name: "Stay on this tab" }));
    expect(screen.getByRole("textbox", { name: "profile draft" })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("unsaved current draft");
    expect(window.location.href).toBe(beforeHref);
    const current = await open(); act(() => current.onSelect(target));
    fireEvent.click(screen.getByRole("button", { name: "Discard & switch" }));
    if (kind === "settings") {
      expect(screen.getByRole("textbox", { name: "chat draft" })).toBeTruthy();
      expect(window.location.search + window.location.hash).toBe("?tab=chat#tts");
      expect(fixture.push).not.toHaveBeenCalled();
    } else {
      expect(fixture.push).toHaveBeenCalledTimes(1);
      expect(fixture.push).toHaveBeenCalledWith("/app/opponents");
    }
  });
});
