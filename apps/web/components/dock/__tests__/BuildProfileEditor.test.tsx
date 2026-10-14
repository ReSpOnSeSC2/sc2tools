import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DEFAULT_BUILD_PROFILE,
  DEFAULT_STUDIO_STATE,
  type StudioBuildProfile,
  type StudioState,
} from "@/lib/multichat/useStudioState";
import { BuildProfileEditor } from "../BuildProfileEditor";

const TEST_PROFILE: StudioBuildProfile = {
  title: "Test build",
  labels: { ...DEFAULT_BUILD_PROFILE.labels },
  ratings: { aggressiveness: 4, defensiveness: 2, executionDifficulty: 3, popularity: 1, micro: 5 },
  visible: false,
};
function state(profile: StudioBuildProfile): StudioState {
  return { ...DEFAULT_STUDIO_STATE, buildProfile: profile };
}
afterEach(cleanup);

describe("BuildProfileEditor", () => {
  it("starts unrated and hidden, with no guessed scores or available show action", () => {
    const onPost = vi.fn();
    render(<BuildProfileEditor profile={DEFAULT_BUILD_PROFILE} busy={false} onPost={onPost} />);
    expect(screen.getAllByRole("combobox").every((element) => (element as HTMLSelectElement).value === "")).toBe(true);
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save ratings" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onPost).not.toHaveBeenCalled();
  });

  it("saves a complete edited profile without changing its visibility", async () => {
    const onPost = vi.fn<(patch: Record<string, unknown>) => Promise<StudioState | null>>(async () => state({ ...TEST_PROFILE, title: "Edited test build" }));
    render(<BuildProfileEditor profile={TEST_PROFILE} busy={false} onPost={onPost} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Build title" }), { target: { value: " Edited test build " } });
    fireEvent.click(screen.getByRole("button", { name: "Save ratings" }));
    await waitFor(() => expect(onPost).toHaveBeenCalledWith({ buildProfile: { title: "Edited test build", ratings: TEST_PROFILE.ratings, labels: TEST_PROFILE.labels } }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Ratings saved.");
    expect(onPost.mock.calls[0][0]).not.toHaveProperty("buildProfile.visible");
  });

  it("keeps a failed save draft intact through incoming polls", async () => {
    const onPost = vi.fn(async () => null);
    const { rerender } = render(<BuildProfileEditor profile={TEST_PROFILE} busy={false} onPost={onPost} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Build title" }), { target: { value: "Unsaved test build" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Aggressiveness" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ratings" }));
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    rerender(<BuildProfileEditor profile={{ ...TEST_PROFILE, title: "Another saved build" }} busy={false} onPost={onPost} />);
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Unsaved test build");
    expect((screen.getByRole("combobox", { name: "Aggressiveness" }) as HTMLSelectElement).value).toBe("2");
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect((screen.getByRole("button", { name: "Save ratings" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows only a saved complete profile using a visibility-only patch", async () => {
    const onPost = vi.fn(async () => state({ ...TEST_PROFILE, visible: true }));
    render(<BuildProfileEditor profile={TEST_PROFILE} busy={false} onPost={onPost} />);
    fireEvent.click(screen.getByRole("button", { name: "Show widget" }));
    await waitFor(() => expect(onPost).toHaveBeenCalledWith({ buildProfile: { visible: true } }));
    expect((await screen.findByRole("status")).textContent).toBe("Widget shown.");
  });

  it("edits an axis label with its rating and preserves both while a poll arrives", async () => {
    const onPost = vi.fn<(patch: Record<string, unknown>) => Promise<StudioState | null>>(async () => null);
    const { rerender } = render(<BuildProfileEditor profile={TEST_PROFILE} busy={false} onPost={onPost} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Build popularity label" }), { target: { value: "How common it is" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Build popularity" }), { target: { value: "4" } });
    rerender(<BuildProfileEditor profile={{ ...TEST_PROFILE, labels: { ...TEST_PROFILE.labels, popularity: "Popularity" } }} busy={false} onPost={onPost} />);
    expect((screen.getByRole("textbox", { name: "Build popularity label" }) as HTMLInputElement).value).toBe("How common it is");
    fireEvent.click(screen.getByRole("button", { name: "Save ratings" }));
    await waitFor(() => expect(onPost).toHaveBeenCalledWith({ buildProfile: {
      title: "Test build",
      labels: { ...TEST_PROFILE.labels, popularity: "How common it is" },
      ratings: { ...TEST_PROFILE.ratings, popularity: 4 },
    } }));
  });

  it("requires nonblank editable labels before saving", () => {
    const onPost = vi.fn();
    render(<BuildProfileEditor profile={TEST_PROFILE} busy={false} onPost={onPost} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Micro required label" }), { target: { value: " " } });
    expect((screen.getByRole("button", { name: "Save ratings" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("can hide a saved visible profile while protecting unrelated draft edits", async () => {
    const visible = { ...TEST_PROFILE, visible: true };
    const onPost = vi.fn(async () => state({ ...visible, visible: false }));
    const { rerender } = render(<BuildProfileEditor profile={visible} busy={false} onPost={onPost} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Build title" }), { target: { value: "Next test build" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide widget" }));
    await waitFor(() => expect(onPost).toHaveBeenCalledWith({ buildProfile: { visible: false } }));
    rerender(<BuildProfileEditor profile={{ ...visible, visible: false }} busy={false} onPost={onPost} />);
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Next test build");
    fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Test build");
  });

  it("locks all input and control actions without a server snapshot or while saving", () => {
    const onPost = vi.fn();
    const { rerender } = render(<BuildProfileEditor profile={TEST_PROFILE} busy={false} ready={false} onPost={onPost} />);
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByRole("combobox").every((element) => (element as HTMLSelectElement).disabled)).toBe(true);
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<BuildProfileEditor profile={TEST_PROFILE} busy onPost={onPost} />);
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
