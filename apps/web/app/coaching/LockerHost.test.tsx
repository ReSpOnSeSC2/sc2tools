import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const token = vi.hoisted(() => vi.fn(async () => "token"));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: token }) }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://localhost:8080" }));
import LockerHost from "./LockerHost";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("ignores a cancelled fetch, recovers from 500, and parks the initialized Locker without running it twice", async () => {
  let finishText: (text: string) => void = () => undefined;
  const text = new Promise<string>((resolve) => { finishText = resolve; });
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, text: () => text }).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, text: async () => '<html><head><style>.fixture { color: red }</style></head><body><div id="locker-fixture">Ready Locker</div><script id="locker-code">/* synthetic fixture */</script></body></html>' });
  vi.stubGlobal("fetch", fetch);
  const first = render(<LockerHost />);
  expect(screen.getByRole("region", { name: "Loading the Locker…" }).getAttribute("aria-busy")).toBe("true");
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce()); first.unmount();
  await act(async () => finishText('<html><body><div id="cancelled-locker">Old Locker</div></body></html>'));
  expect(document.getElementById("cancelled-locker")).toBeNull();
  const view = render(<LockerHost />);
  expect(await screen.findByRole("heading", { name: "The Locker couldn't load" })).toBeTruthy();
  expect(screen.getByText("Your coaching data is safe. Check your connection and try again.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Ready Locker")).toBeTruthy();
  expect(document.querySelectorAll("#locker-code")).toHaveLength(1);
  const root = document.querySelector("[data-coaching-locker]");
  view.unmount(); expect(root?.parentElement?.id).toBe("coaching-locker-parking");
  render(<LockerHost />); expect(screen.getByText("Ready Locker")).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(3); expect(document.querySelectorAll("#locker-code")).toHaveLength(1);
});
