import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomBuild } from "./types";
const h = vi.hoisted(() => ({ props: null as null | { apiPath: string; slug: string; phasePerspective?: string; onEditRules: () => void } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "fixture-owner", isLoaded: true, isSignedIn: true, getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: undefined, mutate: vi.fn() }), apiCall: vi.fn() }));
vi.mock("@/components/practice/PracticeButton", () => ({ PracticeButton: () => <button>Practice</button> }));
vi.mock("./BuildDefinitionCard", () => ({ BuildDefinitionCard: ({ onEdit }: { onEdit: () => void }) => <button onClick={onEdit}>Edit definition</button> }));
vi.mock("./BuildDossier", () => ({ BuildDossier: (props: NonNullable<typeof h.props> & { headerSlot: () => ReactNode }) => {
  h.props = props;
  return <section><button onClick={props.onEditRules}>Edit rules</button>{props.headerSlot()}</section>;
} }));
import { BuildDossierModal } from "./BuildDossierModal";
const build: CustomBuild = { slug: "private opener", name: "Scout opening", race: "Protoss", vsRace: "Zerg", description: "Recorded description", notes: "Private scouting note", perspective: "opponent", isPublic: true };
const callbacks = () => ({ onClose: vi.fn(), onEdit: vi.fn(), onPublish: vi.fn(), onDelete: vi.fn(), onDuplicate: vi.fn(), onReclassify: vi.fn() });
afterEach(() => { cleanup(); h.props = null; });

describe("Build dossier shared dialog", () => {
  it("keeps the private dossier, metadata, notes and action order inside the existing xl shell", () => {
    const actions = callbacks(); render(<BuildDossierModal build={build} {...actions} />);
    const dialog = screen.getByRole("dialog", { name: "Scout opening dossier" });
    expect(dialog.className).toContain("sm:max-w-4xl");
    expect(within(dialog).getByRole("button", { name: "Close" }).className).toContain("h-11");
    expect(screen.queryByRole("button", { name: "Close build dossier" })).toBeNull();
    expect(screen.getByText("Recorded description")).toBeTruthy(); expect(screen.getByText("Private scouting note")).toBeTruthy();
    expect(screen.getByText("From opponent")).toBeTruthy(); expect(screen.getByText("Published")).toBeTruthy();
    expect(h.props).toMatchObject({ apiPath: "/v1/custom-builds/private%20opener/matches", slug: build.slug, phasePerspective: "opponent" });
    // Buttons and links in document order: Edit, Publish, Full page, Delete, each a 44 px target.
    const controls = [...dialog.querySelectorAll<HTMLElement>("button, a")];
    const practice = controls.findIndex(node => node.textContent === "Practice");
    const actions4 = controls.slice(practice + 1, practice + 5);
    expect(actions4.map(node => node.textContent)).toEqual(["Edit", "Update listing", "Full page", "Delete"]);
    for (const node of actions4) expect(node.className.split(/\s+/)).toContain("min-h-11");
    fireEvent.click(screen.getByRole("button", { name: "Edit rules" })); expect(actions.onEdit).toHaveBeenLastCalledWith(build.slug, "preview");
    fireEvent.click(screen.getByRole("button", { name: "Edit definition" })); expect(actions.onEdit).toHaveBeenLastCalledWith(build.slug);
    fireEvent.click(screen.getByRole("button", { name: "Update listing" })); expect(actions.onPublish).toHaveBeenCalledWith(build.slug);
    fireEvent.click(screen.getByRole("button", { name: "Delete" })); expect(actions.onDelete).toHaveBeenCalledWith(build.slug);
    expect(screen.getByRole("link", { name: "Full page" }).getAttribute("href")).toBe("/builds/private%20opener");
  });

  it("routes empty-note editing to the same private notes focus", () => {
    const actions = callbacks(); render(<BuildDossierModal build={{ ...build, notes: "   " }} {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit the build" }));
    expect(actions.onEdit).toHaveBeenCalledWith(build.slug, "notes");
  });

  it("lets the portaled menu own first Escape, then restores the library trigger when the dossier closes", async () => {
    const actions = callbacks();
    function Host() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open dossier</button>{open ? <BuildDossierModal build={{ ...build, isPublic: false }} {...actions} onClose={() => { actions.onClose(); setOpen(false); }} /> : null}</>;
    }
    render(<Host />); const launch = screen.getByRole("button", { name: "Open dossier" }); launch.focus(); fireEvent.click(launch);
    const trigger = screen.getByRole("button", { name: "Build options for Scout opening" }); trigger.focus(); fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Open full page" })));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull(); expect(actions.onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(actions.onClose).toHaveBeenCalledOnce(); expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(launch));
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});
