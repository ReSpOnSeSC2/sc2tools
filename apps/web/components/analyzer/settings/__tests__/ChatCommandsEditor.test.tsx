import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const env = vi.hoisted(() => ({ auth: { userId: "A", isLoaded: true, isSignedIn: true, getToken: vi.fn() }, read: { data: { builtins: [], custom: [] }, isLoading: false, isPreviousData: false, error: null as unknown, mutate: vi.fn() } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => env.auth }));
vi.mock("@/lib/clientApi", async original => ({ ...await original<typeof import("@/lib/clientApi")>(), useApi: () => env.read }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
import { ChatCommandsEditor } from "../ChatCommandsEditor";
import { ChatCommandsCard } from "../ChatCommandsCard";
const writeText = vi.fn();
beforeEach(() => {
  env.auth.userId = "A"; env.auth.isLoaded = true; env.auth.isSignedIn = true; env.auth.getToken.mockReset().mockResolvedValue("jwt-A"); env.read.data = { builtins: [], custom: [] }; env.read.error = null; env.read.mutate.mockReset().mockResolvedValue(undefined);
  writeText.mockReset().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => ({ ok: true, status: 200, json: async () => String(url).endsWith("/try") ? { status: "reply", text: "Hello Viewer · 4W 2L", command: "greet" } : JSON.parse(init?.body as string) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("public Help is a read-only registry guide without private reads or an editor", () => {
  render(<ChatCommandsCard rankRace="protoss" />);
  expect(screen.getByText("!winrate [matchup|race]")).toBeTruthy(); expect(screen.queryByRole("table", { name: "Chat command settings" })).toBeNull(); expect(fetch).not.toHaveBeenCalled();
});
it("adds a custom command locally, saves explicitly, previews exactly and copies the saved Nightbot snippet", async () => {
  render(<ChatCommandsEditor token="synthetic-token" onSaved={vi.fn()} />);
  await screen.findByRole("table", { name: "Chat command settings" });
  fireEvent.click(screen.getByRole("button", { name: "Add custom command" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Alias for Custom command 1" }), { target: { value: "greet" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Reply for Custom command 1" }), { target: { value: "Hello {user} · {record}" } });
  expect(fetch).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Try it · Custom command 1" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Save chat commands" })); await waitFor(() => expect(screen.getByRole("button", { name: "Try it · Custom command 1" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Try it · Custom command 1" })); expect(await screen.findByText("Hello Viewer · 4W 2L")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy Nightbot · Custom command 1" })); await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  expect(writeText.mock.calls[0][0]).toContain("/chatbot/synthetic-token/greet?args=$(querystring)"); expect(fetch).toHaveBeenCalledTimes(2);
});
it("has a selected read-only clipboard fallback and clears private draft/preview on account change", async () => {
  writeText.mockRejectedValue(new Error("synthetic clipboard unavailable")); const view = render(<ChatCommandsEditor token="synthetic-A" onSaved={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Copy Nightbot · !mmr" })); const field = await screen.findByRole("textbox", { name: "Copy this Nightbot snippet" });
  expect(field).toHaveProperty("readOnly", true); expect(document.activeElement).toBe(field); expect((field as HTMLInputElement).selectionEnd).toBe((field as HTMLInputElement).value.length);
  fireEvent.change(screen.getByRole("textbox", { name: "Alias for !mmr" }), { target: { value: "private_alias" } });
  env.auth.userId = "B"; view.rerender(<ChatCommandsEditor token="synthetic-B" onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Alias for !mmr" })).toHaveProperty("value", "mmr")); expect(screen.queryByDisplayValue(/synthetic-A/)).toBeNull();
});
