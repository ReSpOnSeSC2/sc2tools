import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CookieSettingsButton } from "../CookieSettingsButton";
const mock = vi.hoisted(() => ({ configured: true, open: vi.fn() }));
vi.mock("@/lib/analytics/consent", () => ({ isAnalyticsConfigured: () => mock.configured, openCookieSettings: mock.open }));
afterEach(() => { cleanup(); mock.configured = true; mock.open.mockClear(); });
it("opens the shared choice when analytics is configured", () => { render(<CookieSettingsButton />); fireEvent.click(screen.getByRole("button", { name: "Cookie settings" })); expect(mock.open).toHaveBeenCalledOnce(); });
it("leaves the control out when analytics is disabled", () => { mock.configured = false; render(<CookieSettingsButton />); expect(screen.queryByRole("button")).toBeNull(); });
