import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DockGameChapters } from "../DockGameChapters";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(answer: () => Promise<Partial<Response>>) {
  const fetchMock = vi.fn(answer);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const props = { token: "dock-token", enabled: true, youtube: false, busy: false, onToggleYoutube: vi.fn() };

describe("DockGameChapters", () => {
  it("starts with the YouTube switch off and sends the opposite value when pressed", () => {
    const onToggleYoutube = vi.fn();
    render(<DockGameChapters {...props} onToggleYoutube={onToggleYoutube} />);
    const toggle = screen.getByRole("switch", { name: /game chapters to the YouTube archive/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onToggleYoutube).toHaveBeenCalledWith(true);
  });

  it("is disabled until the saved controls have loaded", () => {
    render(<DockGameChapters {...props} enabled={false} />);
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Show game chapters" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("loads the lines once per press and offers them to copy", async () => {
    const fetchMock = stubFetch(async () => ({ ok: true, json: async () => ({ lines: ["0:00 Stream start", "1:00 Game 1 · PvZ win vs 5.1k"], message: "" }) }));
    render(<DockGameChapters {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Show game chapters" }));
    await screen.findByText("1:00 Game 1 · PvZ win vs 5.1k");
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/multichat/dock-token/chapters");
    expect(screen.getByRole("button", { name: /Copy game chapters/ })).toBeTruthy();
  });

  it("says why there is nothing to copy", async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ lines: [], message: "Press Start new session when you go live so chapters know where the stream began." }) }));
    render(<DockGameChapters {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Show game chapters" }));
    await screen.findByText(/Press Start new session/);
    expect(screen.queryByRole("button", { name: /Copy game chapters/ })).toBeNull();
  });

  it("shows a failure with a retry that loads again", async () => {
    let ok = false;
    const fetchMock = stubFetch(async () => ok ? { ok: true, json: async () => ({ lines: ["0:00 A"], message: "" }) } : { ok: false });
    render(<DockGameChapters {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Show game chapters" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn’t load game chapters");
    ok = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("0:00 A")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
