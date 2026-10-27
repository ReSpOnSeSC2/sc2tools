import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ auth: { isLoaded: true, isSignedIn: true, userId: "A" as string | null, getToken: vi.fn<() => Promise<string | null>>() }, push: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));
import { AskForReviewDialog } from "../AskForReviewButton";
const props = { gameId: "shared-private-id", durationSec: 640, matchup: "PvZ", onClose: vi.fn() };
beforeEach(() => { h.auth.userId = "A"; h.auth.isLoaded = true; h.auth.isSignedIn = true; h.auth.getToken.mockReset(); h.push.mockReset(); props.onClose.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("never sends a request held at JWT lookup after the dialog changes accounts", async () => {
  let finish!: (value: string) => void;
  h.auth.getToken.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "request", url: "/reviews/request" }))); vi.stubGlobal("fetch", fetcher);
  const view = render(<AskForReviewDialog {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Why did my blink all-in fail against the roach defence?" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Let reviewers download the replay file/ }));
  fireEvent.click(screen.getByRole("button", { name: "Post request" }));
  await waitFor(() => expect(h.auth.getToken).toHaveBeenCalledOnce());
  h.auth.userId = "B"; view.rerender(<AskForReviewDialog {...props} />);
  expect(screen.getByRole("textbox", { name: "Your question" })).toHaveProperty("value", "");
  expect(screen.getByRole("checkbox", { name: /Let reviewers download the replay file/ })).toHaveProperty("checked", false);
  await act(async () => finish("B-token"));
  expect(fetcher).not.toHaveBeenCalled(); expect(h.push).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
});
