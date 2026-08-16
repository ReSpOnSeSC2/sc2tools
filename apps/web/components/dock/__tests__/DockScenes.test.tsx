import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  StudioBrollConfig,
  StudioScene,
} from "@/lib/multichat/useStudioState";
import {
  BrollLibraryEditor,
  parseBrollLibraryJson,
  parseBrollTimecode,
  parseYouTubeVideoId,
} from "../BrollLibraryEditor";
import { DockScenes } from "../DockScenes";

vi.mock("@/components/overlay/widgets/StreamSceneWidget", () => ({
  formatCountdown: () => "4:59",
}));

vi.mock("../DockClient", () => ({
  DockButton: ({
    disabled,
    onClick,
    children,
  }: {
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

const CLIPS = [
  {
    id: "clip-one",
    title: "Hold the line",
    videoId: "abcDEF_1234",
    startSeconds: 90,
    endSeconds: 150,
  },
  {
    id: "clip-two",
    title: "Base race",
    videoId: "ZYXwvut9876",
    startSeconds: 300,
    endSeconds: 405,
  },
];

const BROLL: StudioBrollConfig = {
  clips: CLIPS,
  shuffle: true,
  muted: false,
  volume: 20,
  skipNonce: 3,
};

const BRB_SCENE: StudioScene = {
  mode: "brb",
  message: "Back shortly",
  countdownEndsAt: null,
  setAtMs: 1,
};

afterEach(() => cleanup());

describe("b-roll input helpers", () => {
  it("extracts IDs from bare, watch, share, live, shorts, and embed inputs", () => {
    const id = "abcDEF_1234";
    expect(parseYouTubeVideoId(id)).toBe(id);
    expect(parseYouTubeVideoId(`https://www.youtube.com/watch?v=${id}&t=90`)).toBe(id);
    expect(parseYouTubeVideoId(`youtu.be/${id}?si=share`)).toBe(id);
    expect(parseYouTubeVideoId(`https://youtube.com/live/${id}`)).toBe(id);
    expect(parseYouTubeVideoId(`https://youtube.com/shorts/${id}`)).toBe(id);
    expect(parseYouTubeVideoId(`https://youtube-nocookie.com/embed/${id}`)).toBe(id);
    expect(parseYouTubeVideoId(`https://example.com/watch?v=${id}`)).toBeNull();
    expect(parseYouTubeVideoId("too-short")).toBeNull();
  });

  it("parses seconds and stream-friendly timecodes within backend bounds", () => {
    expect(parseBrollTimecode("90")).toBe(90);
    expect(parseBrollTimecode("1:30")).toBe(90);
    expect(parseBrollTimecode("1:02:03")).toBe(3723);
    expect(parseBrollTimecode("24:00:00")).toBe(86_400);
    expect(parseBrollTimecode("1:60")).toBeNull();
    expect(parseBrollTimecode("24:00:01")).toBeNull();
    expect(parseBrollTimecode("later")).toBeNull();
  });

  it("imports versioned, nested, and bare clip libraries safely", () => {
    expect(
      parseBrollLibraryJson(JSON.stringify({ version: 1, clips: CLIPS })).clips,
    ).toEqual(CLIPS);
    expect(
      parseBrollLibraryJson(JSON.stringify({ broll: { clips: CLIPS } })).clips,
    ).toEqual(CLIPS);
    expect(parseBrollLibraryJson(JSON.stringify(CLIPS)).clips).toEqual(CLIPS);
    expect(parseBrollLibraryJson("not-json").error).toMatch(/not valid JSON/);
    expect(
      parseBrollLibraryJson(
        JSON.stringify([{ ...CLIPS[0], endSeconds: 90 }]),
      ).error,
    ).toMatch(/invalid time range/);
  });
});

describe("DockScenes b-roll controls", () => {
  it("shows active status and posts complete nested config updates", async () => {
    const onPost = vi.fn<(patch: Record<string, unknown>) => Promise<void>>(
      async () => undefined,
    );
    render(
      <DockScenes
        scene={BRB_SCENE}
        broll={BROLL}
        busy={false}
        onPost={onPost}
      />,
    );

    expect(screen.getByText("B-roll active")).toBeTruthy();
    expect(screen.getByText("2 highlight clips")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Shuffle/ }));
    fireEvent.click(screen.getByRole("button", { name: "Mute b-roll" }));
    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
    const volume = screen.getByRole("slider", { name: "B-roll volume" });
    fireEvent.change(volume, { target: { value: "37" } });
    fireEvent.pointerUp(volume);

    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(4));
    expect(onPost).toHaveBeenNthCalledWith(1, {
      broll: { ...BROLL, shuffle: false },
    });
    expect(onPost).toHaveBeenNthCalledWith(2, {
      broll: { ...BROLL, muted: true },
    });
    expect(onPost).toHaveBeenNthCalledWith(3, {
      broll: { ...BROLL, skipNonce: 4 },
    });
    expect(onPost).toHaveBeenNthCalledWith(4, {
      broll: { ...BROLL, volume: 37 },
    });
  });

  it("reports an empty library and disables playback-only controls", () => {
    const onPost = vi.fn<(patch: Record<string, unknown>) => Promise<void>>(
      async () => undefined,
    );
    render(
      <DockScenes
        scene={null}
        broll={{ ...BROLL, clips: [] }}
        busy={false}
        onPost={onPost}
      />,
    );
    expect(screen.getByText("No b-roll")).toBeTruthy();
    expect(screen.getByText("0 highlight clips")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Shuffle/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /Skip/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("slider", {
        name: "B-roll volume",
      }) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("keeps the existing Starting Soon activation payload unchanged", async () => {
    const onPost = vi.fn<(patch: Record<string, unknown>) => Promise<void>>(
      async () => undefined,
    );
    render(
      <DockScenes
        scene={null}
        broll={BROLL}
        busy={false}
        onPost={onPost}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Optional message/), {
      target: { value: "warming up" },
    });
    fireEvent.click(screen.getByRole("button", { name: "▶ Starting soon" }));
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    const patch = onPost.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("broll");
    expect(patch).toEqual({
      scene: {
        mode: "starting",
        message: "warming up",
        countdownEndsAt: expect.any(Number),
      },
    });
  });
});

describe("BrollLibraryEditor", () => {
  it("adds a URL segment, then rolls its end forward for fast batch cutting", async () => {
    const onPost = vi.fn<(patch: Record<string, unknown>) => Promise<void>>(
      async () => undefined,
    );
    render(
      <BrollLibraryEditor broll={BROLL} busy={false} onPost={onPost} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "YouTube URL or video ID" }), {
      target: { value: "https://youtu.be/qwerty_1234" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "B-roll clip title" }), {
      target: { value: "Storm drop comeback" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "B-roll start time" }), {
      target: { value: "12:30" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "B-roll end time" }), {
      target: { value: "13:05" },
    });
    fireEvent.click(screen.getByRole("button", { name: "+ Add highlight" }));

    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    const update = onPost.mock.calls[0][0] as { broll: StudioBrollConfig };
    expect(update.broll.shuffle).toBe(BROLL.shuffle);
    expect(update.broll.muted).toBe(BROLL.muted);
    expect(update.broll.volume).toBe(BROLL.volume);
    expect(update.broll.skipNonce).toBe(BROLL.skipNonce);
    expect(update.broll.clips.at(-1)).toEqual({
      id: "qwerty_1234-750-785",
      title: "Storm drop comeback",
      videoId: "qwerty_1234",
      startSeconds: 750,
      endSeconds: 785,
    });
    expect(
      (screen.getByRole("textbox", {
        name: "B-roll start time",
      }) as HTMLInputElement).value,
    ).toBe("13:05");
    expect(
      (screen.getByRole("textbox", {
        name: "B-roll end time",
      }) as HTMLInputElement).value,
    ).toBe("");
  });

  it("removes one clip without dropping playback settings", async () => {
    const onPost = vi.fn<(patch: Record<string, unknown>) => Promise<void>>(
      async () => undefined,
    );
    render(
      <BrollLibraryEditor broll={BROLL} busy={false} onPost={onPost} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove Hold the line" }));
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    expect(onPost).toHaveBeenCalledWith({
      broll: { ...BROLL, clips: [CLIPS[1]] },
    });
  });

  it("replaces clips from JSON while preserving live audio and order settings", async () => {
    const onPost = vi.fn<(patch: Record<string, unknown>) => Promise<void>>(
      async () => undefined,
    );
    render(
      <BrollLibraryEditor broll={BROLL} busy={false} onPost={onPost} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "B-roll library JSON" }), {
      target: { value: JSON.stringify({ version: 1, clips: [CLIPS[1]] }) },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Replace library from JSON" }),
    );
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    expect(onPost).toHaveBeenCalledWith({
      broll: { ...BROLL, clips: [CLIPS[1]] },
    });
    expect(await screen.findByText("Imported 1 clip.")).toBeTruthy();
  });

  it("imports a selected JSON file through the same validation and save path", async () => {
    const onPost = vi.fn<(patch: Record<string, unknown>) => Promise<void>>(
      async () => undefined,
    );
    render(
      <BrollLibraryEditor broll={BROLL} busy={false} onPost={onPost} />,
    );
    const library = JSON.stringify({ version: 1, clips: [CLIPS[1]] });
    const file = new File([library], "stream-highlights.json", {
      type: "application/json",
    });

    fireEvent.change(
      screen.getByLabelText("Import b-roll library JSON file"),
      { target: { files: [file] } },
    );

    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    expect(onPost).toHaveBeenCalledWith({
      broll: { ...BROLL, clips: [CLIPS[1]] },
    });
    expect(
      (screen.getByRole("textbox", {
        name: "B-roll library JSON",
      }) as HTMLTextAreaElement).value,
    ).toBe(library);
    expect((await screen.findByRole("status")).textContent).toContain(
      "Imported 1 clip.",
    );
  });

  it("reports invalid file JSON without saving and disables file import while busy", async () => {
    const onPost = vi.fn<(patch: Record<string, unknown>) => Promise<void>>(
      async () => undefined,
    );
    const { rerender } = render(
      <BrollLibraryEditor broll={BROLL} busy={false} onPost={onPost} />,
    );
    const picker = screen.getByLabelText(
      "Import b-roll library JSON file",
    ) as HTMLInputElement;
    fireEvent.change(picker, {
      target: { files: [new File(["not-json"], "broken.json")] },
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "That is not valid JSON.",
    );
    expect(onPost).not.toHaveBeenCalled();

    rerender(<BrollLibraryEditor broll={BROLL} busy onPost={onPost} />);
    expect(
      (screen.getByLabelText(
        "Import b-roll library JSON file",
      ) as HTMLInputElement).disabled,
    ).toBe(true);
  });
});
