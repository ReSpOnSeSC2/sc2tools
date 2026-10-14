import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { DEFAULT_BUILD_PROFILE, DEFAULT_STUDIO_STATE } from "@/lib/multichat/useStudioState";
import { SettingsBuildProfile } from "../SettingsBuildProfile";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "test-session", isLoaded: true, isSignedIn: true, userId: "test-user" }) }));
const TEST_PROFILE = {
  ...DEFAULT_BUILD_PROFILE,
  title: "Test build",
  ratings: { aggressiveness: 4, defensiveness: 2, executionDifficulty: 3, popularity: 1, micro: 5 },
  visible: false,
};
const STUDIO = { ...DEFAULT_STUDIO_STATE, buildProfile: TEST_PROFILE };
function renderSettings() {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><SettingsBuildProfile token="test-token" /></SWRConfig>);
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Settings build profile", () => {
  it("uses the authenticated token state and saves editable labels without auto-showing", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/v1/multichat/test-token/studio");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-session");
      if (init?.method === "POST") {
        const patch = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({ ...STUDIO, buildProfile: { ...TEST_PROFILE, ...patch.buildProfile } }) };
      }
      return { ok: true, json: async () => STUDIO };
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Test build"));
    fireEvent.change(screen.getByRole("textbox", { name: "Build popularity label" }), { target: { value: "How common it is" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ratings" }));
    expect((await screen.findByRole("status")).textContent).toBe("Ratings saved.");
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ buildProfile: { title: "Test build", ratings: TEST_PROFILE.ratings, labels: { ...TEST_PROFILE.labels, popularity: "How common it is" } } });
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Hide widget" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a failed save draft and the saved visibility controls intact", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: false, status: 503, text: async () => "Unavailable" };
      return { ok: true, json: async () => STUDIO };
    }));
    renderSettings();
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Test build"));
    fireEvent.change(screen.getByRole("textbox", { name: "Build title" }), { target: { value: "Unsaved test build" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ratings" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Save failed");
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Unsaved test build");
    expect((screen.getByRole("button", { name: "Save ratings" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps show and inputs locked when saved ratings cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: async () => "Unavailable" })));
    renderSettings();
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load saved ratings");
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
