import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { deliverShareCard, shareOutcome } from "../ShareCard";

/**
 * deliverShareCard reports which path delivered the card, so share
 * events can be counted by path, and reports nothing delivered when the
 * player dismisses the share sheet. Each test offers the browser exactly
 * the capabilities named in its title.
 */

const PNG = new Blob(["png-bytes"], { type: "image/png" });
const INPUT = { blob: PNG, title: "Card", text: "Card text\n\nhttps://sc2tools.com/arcade" };

/** Clipboard that accepts images. */
class FakeClipboardItem {
  constructor(public items: Record<string, Blob>) {}
}

function setNavigator(parts: Record<string, unknown>) {
  vi.stubGlobal("navigator", parts);
}

/** The download link's cleanup runs on the next tick. */
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

// jsdom has no object URLs. Give it a pair for the whole file and take
// them away again only after any pending download cleanup has run.
const realObjectUrls = {
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
};
const createObjectURL = vi.fn(() => "blob:card");
const revokeObjectURL = vi.fn();
let click: MockInstance;

beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(async () => {
  await nextTick();
  URL.createObjectURL = realObjectUrls.createObjectURL;
  URL.revokeObjectURL = realObjectUrls.revokeObjectURL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deliverShareCard", () => {
  it("uses the Web Share sheet when the browser can share files", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigator({ share, canShare: () => true });

    expect(await deliverShareCard(INPUT)).toEqual({ shared: true, method: "web_share" });
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0][0].text).toBe(INPUT.text);
    expect(click).not.toHaveBeenCalled();
  });

  it("delivers nothing when the player dismisses the share sheet", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("Share canceled", "AbortError"));
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator({ share, canShare: () => true, clipboard: { write, writeText } });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    expect(await deliverShareCard(INPUT)).toEqual({ shared: false, method: null });
    // Declining to share must not copy or download the card behind the player's back.
    expect(write).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("falls back to the clipboard when the share sheet fails for another reason", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("Not allowed", "NotAllowedError"));
    const write = vi.fn().mockResolvedValue(undefined);
    setNavigator({ share, canShare: () => true, clipboard: { write } });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    expect(await deliverShareCard(INPUT)).toEqual({ shared: true, method: "clipboard_image" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("copies the image when the share sheet cannot take files", async () => {
    const share = vi.fn();
    const write = vi.fn().mockResolvedValue(undefined);
    setNavigator({ share, canShare: () => false, clipboard: { write } });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    expect(await deliverShareCard(INPUT)).toEqual({ shared: true, method: "clipboard_image" });
    expect(share).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("copies the text when the clipboard cannot hold images", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator({ clipboard: { writeText } });
    vi.stubGlobal("ClipboardItem", undefined);

    expect(await deliverShareCard(INPUT)).toEqual({ shared: true, method: "clipboard_text" });
    expect(writeText).toHaveBeenCalledWith(INPUT.text);
  });

  it("downloads the image when nothing else is available", async () => {
    setNavigator({});
    vi.stubGlobal("ClipboardItem", undefined);

    expect(await deliverShareCard({ ...INPUT, filename: "sc2-card.png" })).toEqual({
      shared: true,
      method: "download",
    });
    expect(createObjectURL).toHaveBeenCalledWith(PNG);
    expect(click).toHaveBeenCalledTimes(1);

    await nextTick();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("downloads when the clipboard refuses", async () => {
    const write = vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    setNavigator({ clipboard: { write } });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    expect(await deliverShareCard(INPUT)).toEqual({ shared: true, method: "download" });
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe("shareOutcome", () => {
  it("names what actually happened to the card", () => {
    expect(shareOutcome("Recap", "web_share")).toBe("Recap shared");
    expect(shareOutcome("Recap", "clipboard_image")).toBe("Recap copied");
    expect(shareOutcome("Battle card", "clipboard_text")).toBe("Battle card copied");
    expect(shareOutcome("Battle card", "download")).toBe("Battle card saved");
  });
});
