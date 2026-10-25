import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PracticeButton } from "./PracticeButton";
import { queuePendingIntent } from "@/lib/pendingIntent";

const h = vi.hoisted(() => ({ auth: { isLoaded: true, isSignedIn: true, userId: "a", getToken: vi.fn() }, assign: vi.fn(), mutate: vi.fn(), push: vi.fn(), success: vi.fn(), event: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: h.mutate }) }));
vi.mock("@/lib/practiceAssignment", () => ({ assignPractice: (...args: unknown[]) => h.assign(...args) }));
vi.mock("@/lib/useGhostPractice", () => ({ useGhostPractice: () => ({ config: { v: 2, slots: {} }, loading: false, saving: false }) }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => ({ toast: { success: h.success } }) }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: (...args: unknown[]) => h.event(...args) }));
const path = "/community/builds/blink?sort=popular";
const input = { build: { name: "Blink opening", slug: "blink", race: "Protoss", vsRace: "Terran" } };
const result = { target: { v: 1, name: "Blink opening", steps: [{ supply: null, name: "Gateway", t: 40 }] }, config: { v: 2, revision: 3, slots: {} }, source: "Rule deadlines" };
beforeEach(() => {
  window.history.replaceState({}, "", path); sessionStorage.clear(); localStorage.clear();
  h.auth = { isLoaded: true, isSignedIn: true, userId: "a", getToken: vi.fn().mockResolvedValue("jwt-a") };
  h.push.mockReset(); h.success.mockReset(); h.event.mockReset(); h.mutate.mockReset().mockResolvedValue(undefined);
  h.assign.mockReset().mockImplementation(async (_input, _slot, getToken) => { await getToken(); return result; });
});
afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

it("resumes the chosen public matchup once across StrictMode and responsive copies", async () => {
  queuePendingIntent("arm-ghost", { input, matchup: "PvZ" }, path);
  render(<StrictMode><PracticeButton {...input} /><PracticeButton {...input} /></StrictMode>);
  await waitFor(() => expect(h.push).toHaveBeenCalledWith("/settings?tab=overlay#ghost"));
  expect(h.assign).toHaveBeenCalledOnce(); expect(h.assign.mock.calls[0][1]).toBe("PvZ");
  expect(h.success).toHaveBeenCalledOnce(); expect(sessionStorage.getItem("sc2tools:auth-intent:v1")).toBeNull();
  expect(h.event).toHaveBeenCalledWith("auth_intent_completed", { kind: "arm-ghost" });
});

it("does not claim an action from a different public URL", async () => {
  queuePendingIntent("arm-ghost", { input, matchup: "PvZ" }, "/community/builds/blink");
  render(<PracticeButton {...input} />);
  await act(async () => { await Promise.resolve(); });
  expect(h.assign).not.toHaveBeenCalled(); expect(sessionStorage.getItem("sc2tools:auth-intent:v1")).not.toBeNull();
});

it("disables both responsive copies while one holds the automatic save", async () => {
  queuePendingIntent("arm-ghost", { input, matchup: "PvZ" }, path);
  let release!: (value: typeof result) => void;
  h.assign.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  render(<><PracticeButton {...input} /><PracticeButton {...input} /></>);
  await waitFor(() => expect(h.assign).toHaveBeenCalledOnce());
  await waitFor(() => {
    const buttons = screen.getAllByRole("button", { name: "Saving practice…" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true);
  });
  for (const button of screen.getAllByRole("button", { name: "Saving practice…" })) fireEvent.click(button);
  expect(h.assign).toHaveBeenCalledOnce();
  await act(async () => { release(result); await Promise.resolve(); });
  await waitFor(() => expect(h.push).toHaveBeenCalledOnce());
});

it("never applies a held save after an account switch or updates the wrong cache", async () => {
  queuePendingIntent("arm-ghost", { input, matchup: "PvZ" }, path);
  let release!: (value: typeof result) => void;
  h.assign.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = render(<PracticeButton {...input} />);
  await waitFor(() => expect(h.assign).toHaveBeenCalledOnce());
  h.auth = { ...h.auth, userId: "b" }; view.rerender(<PracticeButton {...input} />);
  h.auth = { ...h.auth, userId: "a" }; view.rerender(<PracticeButton {...input} />);
  await act(async () => { release(result); await Promise.resolve(); });
  expect(h.mutate).not.toHaveBeenCalled(); expect(h.push).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled();
});

it("shows an ordinary retry path when the original practice action fails", async () => {
  queuePendingIntent("arm-ghost", { input, matchup: "PvZ" }, path);
  h.assign.mockRejectedValueOnce(new Error("Offline")); render(<PracticeButton {...input} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Use the action button to try again");
  expect(h.push).not.toHaveBeenCalled();
});

it("shows a hidden claimant's failure in both copies and clears it on manual retry", async () => {
  queuePendingIntent("arm-ghost", { input, matchup: "PvZ" }, path);
  let reject!: (error: Error) => void;
  h.assign.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  render(<><span hidden><PracticeButton {...input} /></span><PracticeButton {...input} /></>);
  await waitFor(() => expect(h.assign).toHaveBeenCalledOnce());
  await act(async () => { reject(new Error("Offline")); });
  await waitFor(() => expect(document.querySelectorAll('[role="alert"]')).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: /^Practice in PvT$/ }));
  await screen.findByText(/Your Ghost URL updates automatically/);
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0); expect(h.assign).toHaveBeenCalledTimes(2);
});
