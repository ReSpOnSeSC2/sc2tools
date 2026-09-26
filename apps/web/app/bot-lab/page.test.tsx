import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), notFound: vi.fn(() => { throw new Error("404"); }) }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("./BotLab", () => ({ BotLab: () => null }));
import BotLabPage from "./page";
beforeEach(() => { mocks.auth.mockReset().mockResolvedValue({ userId: "admin" }); mocks.notFound.mockClear(); });
afterEach(() => vi.unstubAllEnvs());
describe("bot practice server gate", () => {
  it("returns 404 by default before authenticating or rendering the client", async () => {
    vi.stubEnv("BOT_LAB_ENABLED", "");
    await expect(BotLabPage()).rejects.toThrow("404"); expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("returns 404 for an authenticated non-admin", async () => {
    vi.stubEnv("BOT_LAB_ENABLED", "true"); vi.stubEnv("SC2TOOLS_ADMIN_USER_IDS", "someone-else");
    await expect(BotLabPage()).rejects.toThrow("404");
  });
  it("renders only when both server flag and admin membership are present", async () => {
    vi.stubEnv("BOT_LAB_ENABLED", "true"); vi.stubEnv("SC2TOOLS_ADMIN_USER_IDS", "first, admin\nlast");
    expect(await BotLabPage()).toBeTruthy(); expect(mocks.notFound).not.toHaveBeenCalled();
  });
});
