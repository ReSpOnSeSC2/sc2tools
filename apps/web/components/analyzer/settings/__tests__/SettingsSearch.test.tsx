import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSearch } from "../SettingsSearch";

const retained = vi.hoisted(() => ({ choose: [] as Array<(value: string) => void> }));
vi.mock("@/components/ui/Combobox", async original => {
  const actual = await original<typeof import("@/components/ui/Combobox")>();
  return { ...actual, Combobox: (props: Parameters<typeof actual.Combobox>[0]) => {
    retained.choose.push(props.onChange); return <actual.Combobox {...props} />;
  } };
});
beforeEach(() => { retained.choose.length = 0; vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Find a setting", () => {
  it("uses the actual combobox keyboard flow and static synonyms without private requests", () => {
    const navigate = vi.fn(); render(<SettingsSearch ownerKey="a" onNavigate={navigate} />);
    const input = screen.getByRole("combobox", { name: "Find a setting" });
    fireEvent.change(input, { target: { value: "TTS volume" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option").id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).toHaveBeenCalledTimes(1); expect(navigate).toHaveBeenCalledWith("/settings?tab=chat#tts");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("has an empty state and Escape closes results without navigation", () => {
    const navigate = vi.fn(); render(<SettingsSearch ownerKey="a" onNavigate={navigate} />);
    const input = screen.getByRole("combobox", { name: "Find a setting" });
    fireEvent.change(input, { target: { value: "no-such-setting-xyz" } });
    expect(screen.getByText("No settings match. Try another word.")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.getAttribute("aria-expanded")).toBe("false"); expect(navigate).not.toHaveBeenCalled();
  });
  it("registers slash once and never hijacks an editable field or open dialog", () => {
    const view = render(<><input aria-label="Draft" /><SettingsSearch ownerKey="a" onNavigate={vi.fn()} /></>);
    const search = screen.getByRole("combobox", { name: "Find a setting" }), draft = screen.getByRole("textbox", { name: "Draft" });
    draft.focus(); fireEvent.keyDown(document, { key: "/" }); expect(document.activeElement).toBe(draft);
    draft.blur(); fireEvent.keyDown(document, { key: "/" }); expect(document.activeElement).toBe(search);
    search.blur();
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); document.body.append(dialog);
    fireEvent.keyDown(document, { key: "/" }); expect(document.activeElement).not.toBe(search); dialog.remove();
    view.unmount(); fireEvent.keyDown(document, { key: "/" }); expect(document.activeElement).not.toBe(search);
  });
  it("retires old-query and owner A→B→A callbacks while admitting the current result", () => {
    const navigate = vi.fn(), owner = (key: string) => <SettingsSearch ownerKey={key} onNavigate={navigate} />;
    const view = render(owner("a"));
    const oldQuery = retained.choose.at(-1)!;
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Pulse ID" } });
    act(() => oldQuery("pulse-ids")); expect(navigate).not.toHaveBeenCalled();
    const oldOwner = retained.choose.at(-1)!;
    view.rerender(owner("b")); view.rerender(owner("a"));
    act(() => oldOwner("pulse-ids")); expect(navigate).not.toHaveBeenCalled();
    act(() => retained.choose.at(-1)!("pulse-ids"));
    expect(navigate).toHaveBeenCalledTimes(1); expect(navigate).toHaveBeenCalledWith("/settings?tab=profile#pulse-ids");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("an admitted retained result uses the current navigation guard after same-query rerenders", () => {
    const before = vi.fn(), current = vi.fn();
    const view = render(<SettingsSearch ownerKey="a" onNavigate={before} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Delete account" } });
    const oldChoice = retained.choose.at(-1)!;
    view.rerender(<SettingsSearch ownerKey="a" onNavigate={current} />);
    act(() => oldChoice("gdpr"));
    expect(before).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1); expect(current).toHaveBeenCalledWith("/settings?tab=backups#gdpr");
  });
});
