/**
 * The Chat & alerts tab holds two forms with their own Save buttons —
 * Multi-platform chat and the chat bot. Both publish
 * their unsaved state, so switching tabs asks before dropping either
 * one's edits, the tab shows the unsaved dot for either, and saving one
 * never clears the other's. The real forms render; the API and Clerk
 * are MOCKS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import { SettingsShell } from "../SettingsShell";
import { SettingsMultiChat } from "../SettingsMultiChat";
import { OverlayBotSettings } from "../OverlayDockSetup";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));

const BOT = {
  enabled: false,
  username: "",
  channel: "",
  replyCommands: true,
  announceOracle: true,
  announceLevelUps: true,
  hasToken: false,
  status: { state: "off", channel: null, lastError: null, lastConnectedAt: null },
};

const api = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  apiCall: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "token", isLoaded: true, isSignedIn: true, userId: "synthetic-owner" }),
}));

vi.mock("@/lib/clientApi", async (importOriginal) => {
  const { useOwnerRequestScope, boundedApiRequest } = await importOriginal<typeof import("@/lib/clientApi")>();
  return {
    useOwnerRequestScope,
    boundedApiRequest,
    API_BASE: "https://api.test",
    useApi: (path: string) => ({
      data: api.data[path],
      isLoading: false,
      error: null,
      mutate: async () => api.data[path],
    }),
    apiCall: api.apiCall,
  };
});

beforeEach(() => {
  api.data = {
    "/v1/me/preferences/multichat": {},
    "/v1/me/chatbot": BOT,
    "/v1/me/integrations": { platforms: [] },
  };
  api.apiCall.mockReset();
  api.apiCall.mockImplementation(async (_getToken: unknown, path: string) =>
    path === "/v1/me/chatbot" ? BOT : {},
  );
  window.history.replaceState(null, "", "/settings?tab=chat");
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

function renderChat() {
  return render(
    <ToastProvider>
      <SettingsShell
        initialTab="chat"
        renderTab={(id) => (id === "chat" ? <><SettingsMultiChat token="tok" /><OverlayBotSettings /></> : <p>panel {id}</p>)}
      />
    </ToastProvider>,
  );
}

/** The desktop sidebar's Chat tab. */
function chatTab() {
  const tabs = screen.getAllByRole("tab", { name: /^Chat & alerts/ });
  return tabs[tabs.length - 1];
}

function chatIsDirty() {
  return within(chatTab()).queryByLabelText("Unsaved changes") !== null;
}

function clickVoice() {
  fireEvent.click(screen.getAllByRole("tab", { name: "Voice" })[0]);
}

function editMultiChat() {
  fireEvent.change(screen.getByLabelText(/Loyalty rank theme/), { target: { value: "zerg" } });
}

function editChatBot() {
  fireEvent.change(screen.getByLabelText("Bot username"), { target: { value: "mybot" } });
}

const dialog = () => screen.queryByRole("dialog", { name: "Discard unsaved changes?" });

describe("Chat tab unsaved-changes guard", () => {
  it("guards a field search against both actual Chat dirty publishers without a write", () => {
    renderChat(); editMultiChat(); editChatBot();
    const search = screen.getByRole("combobox", { name: "Find a setting" });
    fireEvent.change(search, { target: { value: "Delete account" } });
    fireEvent.keyDown(search, { key: "ArrowDown" }); fireEvent.keyDown(search, { key: "Enter" });
    expect(dialog()).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Stay on this tab" }));
    expect((screen.getByLabelText(/Loyalty rank theme/) as HTMLSelectElement).value).toBe("zerg");
    expect((screen.getByLabelText("Bot username") as HTMLInputElement).value).toBe("mybot");
    expect(window.location.search).toBe("?tab=chat"); expect(api.apiCall).not.toHaveBeenCalled();
  });
  it("asks before a tab switch drops Multi-platform chat edits", () => {
    renderChat();
    expect(chatIsDirty()).toBe(false);
    editMultiChat();
    expect(chatIsDirty()).toBe(true);

    clickVoice();
    expect(dialog()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stay on this tab" }));
    expect(dialog()).toBeNull();
    // Still on Chat, edits intact.
    expect((screen.getByLabelText(/Loyalty rank theme/) as HTMLSelectElement).value).toBe("zerg");

    clickVoice();
    fireEvent.click(screen.getByRole("button", { name: "Discard & switch" }));
    expect(screen.getByText("panel voice")).toBeTruthy();
    expect(chatIsDirty()).toBe(false);
  });

  it("marks Chat unsaved for chat bot edits alone, and guards them", () => {
    renderChat();
    editChatBot();
    expect(chatIsDirty()).toBe(true);
    clickVoice();
    expect(dialog()).toBeTruthy();
  });

  it("keeps the dot while the other form still has edits after one saves", async () => {
    renderChat();
    editMultiChat();
    editChatBot();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save bot settings" }));
    });
    expect(api.apiCall).toHaveBeenCalledWith(expect.anything(), "/v1/me/chatbot", expect.anything());
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save bot settings" }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect(chatIsDirty()).toBe(true);
    clickVoice();
    expect(dialog()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stay on this tab" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save chat settings" }));
    });
    await waitFor(() => expect(chatIsDirty()).toBe(false));
    clickVoice();
    expect(dialog()).toBeNull();
    expect(screen.getByText("panel voice")).toBeTruthy();
  });
});
