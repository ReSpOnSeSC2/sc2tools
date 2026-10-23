import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import { SettingsProfile } from "../SettingsProfile";
import { SettingsVoice } from "../SettingsVoice";
import { SettingsRandomizer } from "../SettingsRandomizer";
import { SettingsMisc } from "../SettingsMisc";
const mocks = vi.hoisted(() => ({ mutate: vi.fn(), call: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ error: { status: 503, code: "server_busy" }, data: undefined, isLoading: false, mutate: mocks.mutate }), apiCall: mocks.call }));
vi.mock("@/components/builds/useCustomBuildPage", () => ({ useCustomBuildPage: () => ({ data: undefined }) }));
afterEach(() => { cleanup(); mocks.mutate.mockClear(); mocks.call.mockClear(); });
it.each([["Profile", SettingsProfile], ["Voice", SettingsVoice], ["Randomizer", SettingsRandomizer], ["Misc", SettingsMisc]])("%s never shows an editable blank form after a failed read", (_name, Tab) => {
  const { container } = render(<ToastProvider><Tab /></ToastProvider>);
  expect(container.querySelector("input,select,textarea")).toBeNull();
  expect(screen.getByText("Your saved settings haven't changed.")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(mocks.mutate).toHaveBeenCalledOnce(); expect(mocks.call).not.toHaveBeenCalled();
});
