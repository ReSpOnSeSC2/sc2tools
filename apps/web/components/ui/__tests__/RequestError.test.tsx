import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RequestError } from "../RequestError";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RequestError", () => {
  it.each([
    [{ status: 0, code: "network_unavailable", message: "" }, "Can't reach SC2 Tools"],
    [{ status: 0, code: "request_timeout", message: "" }, "This took too long to load"],
    [{ status: 503, code: "opponent_profile_busy", message: "" }, "The server is busy"],
    [{ status: 401, code: "unauthorized", message: "" }, "You're signed out"],
    [{ status: 500, code: "internal_error", message: "" }, "Something went wrong on our side"],
  ])("explains %o in plain words", (error, title) => {
    render(<RequestError error={error} />);
    expect(screen.getByRole("alert").textContent).toContain(title);
  });

  it("offers sign-in for an expired session", () => {
    render(<RequestError error={{ status: 401, message: "" }} />);
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/sign-in");
  });

  it("adds the filters line only when asked", () => {
    const { rerender } = render(<RequestError error={{ status: 500, message: "" }} />);
    expect(screen.queryByText(/Your filters are still applied/)).toBeNull();
    rerender(<RequestError error={{ status: 500, message: "" }} filtered />);
    expect(screen.getByText(/Your filters are still applied\./)).toBeTruthy();
  });

  it("applies per-kind copy overrides", () => {
    render(
      <RequestError
        error={{ status: 503, code: "opponent_profile_busy", message: "" }}
        copy={{ busy: { title: "The dossier is busy, try again in a moment" } }}
      />,
    );
    expect(screen.getByText("The dossier is busy, try again in a moment")).toBeTruthy();
  });

  it("marks Retry busy while the request runs and keeps it focusable", async () => {
    let finish!: () => void;
    const onRetry = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<RequestError error={{ status: 500, message: "" }} onRetry={onRetry} />);
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    const busy = screen.getByRole("button", { name: "Retrying…" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.hasAttribute("disabled")).toBe(false);
    fireEvent.click(busy);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Still not loading");
  });

  it("hides Retry when there is nothing to retry", () => {
    render(<RequestError error={{ status: 500, message: "" }} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows a short Error ID and copies the whole id", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<RequestError error={{ status: 500, message: "", requestId: "1a2b3c4d-0000-4000-8000-feedfacecafe" }} />);
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("1a2b3c4d").getAttribute("title")).toBe("1a2b3c4d-0000-4000-8000-feedfacecafe");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy error ID" }));
    });
    expect(writeText).toHaveBeenCalledWith("1a2b3c4d-0000-4000-8000-feedfacecafe");
    expect(screen.getByRole("button", { name: "Error ID copied" })).toBeTruthy();
  });

  it("omits the Error ID when the request never reached the server", () => {
    render(<RequestError error={new TypeError("Failed to fetch")} />);
    expect(screen.queryByText(/Error ID/)).toBeNull();
  });

  it("links to the help article", () => {
    render(<RequestError error={{ status: 500, message: "" }} />);
    expect(screen.getByRole("link", { name: "What does this mean?" }).getAttribute("href")).toBe(
      "/help/something-went-wrong",
    );
  });

  it("wraps itself in a titled card when given a title", () => {
    render(<RequestError error={{ status: 500, message: "" }} title="Matchups" />);
    expect(screen.getByRole("heading", { name: "Matchups" })).toBeTruthy();
  });
});
