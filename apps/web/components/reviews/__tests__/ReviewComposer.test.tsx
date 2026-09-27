import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "token"),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: harness.getToken }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: harness.apiCall }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));

import { ReviewComposer } from "../ReviewComposer";
import { validateComment, validateQuestion } from "@/lib/reviews";

afterEach(() => cleanup());
beforeEach(() => {
  harness.apiCall.mockReset();
  harness.apiCall.mockResolvedValue({ id: "c1" });
});

function renderComposer(overrides: Partial<Parameters<typeof ReviewComposer>[0]> = {}) {
  const onPosted = vi.fn();
  const utils = render(
    <ReviewComposer
      requestId="AAAAAAAAAAAAAAAA"
      durationSec={640}
      currentTime={330}
      initialTime={312}
      draftPin={null}
      pinMode={false}
      onTogglePinMode={() => {}}
      onClearPin={() => {}}
      onPosted={onPosted}
      canPin
      {...overrides}
    />,
  );
  return { ...utils, onPosted };
}

describe("comment validation rules", () => {
  it("mirror the API", () => {
    expect(validateComment({ body: "too short", gameTimeSec: 1, endTimeSec: null }, 640)).toMatch(/at least 10/);
    expect(validateComment({ body: "x".repeat(2001), gameTimeSec: 1, endTimeSec: null }, 640)).toMatch(/2,000/);
    expect(validateComment({ body: "Scout the natural first.", gameTimeSec: 700, endTimeSec: null }, 640)).toMatch(/after the game/);
    expect(validateComment({ body: "Scout the natural first.", gameTimeSec: 100, endTimeSec: 90 }, 640)).toMatch(/end after/);
    expect(validateComment({ body: "Scout the natural first.", gameTimeSec: 100, endTimeSec: 500 }, 640)).toMatch(/5 minutes/);
    const links = Array.from({ length: 6 }, (_, i) => `https://e.x/${i}`).join(" ");
    expect(validateComment({ body: links, gameTimeSec: 1, endTimeSec: null }, 640)).toMatch(/at most 5 links/);
    expect(validateComment({ body: "Scout the natural first.", gameTimeSec: 100, endTimeSec: 130 }, 640)).toBeNull();
    expect(validateQuestion("short")).toMatch(/at least 20/);
    expect(validateQuestion("Why did my blink all-in fail here?")).toBeNull();
  });
});

describe("ReviewComposer", () => {
  it("captures the moment and blocks invalid submissions", async () => {
    renderComposer();
    expect(screen.getByTestId("composer-time").textContent).toContain("at 5:12");
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment at 5:12" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/at least 10/);
    expect(harness.apiCall).not.toHaveBeenCalled();
  });

  it("builds a ranged, pinned comment and posts it", async () => {
    const { onPosted } = renderComposer({ draftPin: { x: 40.44, y: 61.26, t: 312 } });
    fireEvent.click(screen.getByRole("button", { name: "End range here" }));
    expect(screen.getByTestId("composer-time").textContent).toContain("5:12–5:30");
    expect(screen.getByTestId("composer-pin").textContent).toContain("Pin at (40, 61)");
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "  Hold the blink until 5:40.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Comment at 5:12" }));
    await waitFor(() => expect(onPosted).toHaveBeenCalledWith("c1"));
    const [, path, init] = harness.apiCall.mock.calls[0];
    expect(path).toBe("/v1/reviews/AAAAAAAAAAAAAAAA/comments");
    expect(JSON.parse(init.body)).toEqual({
      body: "Hold the blink until 5:40.",
      gameTimeSec: 312,
      endTimeSec: 330,
      mapPoint: { x: 40.4, y: 61.3 },
      parentId: null,
    });
  });

  it("re-captures the current time and shows server errors", async () => {
    harness.apiCall.mockRejectedValueOnce({ status: 429, message: "You can post 30 comments per hour. Try again later." });
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /Use current time \(5:30\)/ }));
    expect(screen.getByTestId("composer-time").textContent).toContain("at 5:30");
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Your probe count stalled here." } });
    fireEvent.click(screen.getByRole("button", { name: "Comment at 5:30" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/30 comments per hour/);
  });

  it("offers pin mode only when there is map playback", () => {
    const onTogglePinMode = vi.fn();
    const { rerender } = renderComposer({ onTogglePinMode });
    fireEvent.click(screen.getByRole("button", { name: "Pin a spot on the map" }));
    expect(onTogglePinMode).toHaveBeenCalled();
    rerender(
      <ReviewComposer requestId="AAAAAAAAAAAAAAAA" durationSec={640} currentTime={0} initialTime={0} draftPin={null}
        pinMode={false} onTogglePinMode={() => {}} onClearPin={() => {}} onPosted={() => {}} canPin={false} />,
    );
    expect(screen.queryByRole("button", { name: "Pin a spot on the map" })).toBeNull();
  });
});
