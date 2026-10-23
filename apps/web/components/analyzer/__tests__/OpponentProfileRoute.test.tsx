import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Link from "next/link";
const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../ProfileView", () => ({ ProfileView: ({ onBack, backHref }: { onBack: () => void; backHref: string }) => <><Link href={backHref}>All opponents</Link><button onClick={onBack}>Follow Back</button></> }));
import { OpponentProfileRoute } from "../OpponentProfileRoute";
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); });
it("uses browser Back when the dossier came from the list", () => {
  sessionStorage.setItem("opponents:from-list", "1");
  sessionStorage.setItem("opponents:list-state", JSON.stringify({ listUrl: "/app/opponents?q=Alpha&sort=games" }));
  vi.spyOn(window.history, "length", "get").mockReturnValue(2);
  render(<OpponentProfileRoute pulseId="123" />);
  expect(screen.getByRole("link").getAttribute("href")).toBe("/app/opponents?q=Alpha&sort=games");
  fireEvent.click(screen.getByRole("button")); expect(router.back).toHaveBeenCalledOnce(); expect(router.push).not.toHaveBeenCalled();
});
it("keeps a real fallback list link for a new tab and follows it without the from-list flag", () => {
  sessionStorage.setItem("opponents:list-state", JSON.stringify({ listUrl: "/app/opponents?notes=1" }));
  render(<OpponentProfileRoute pulseId="123" />);
  expect(screen.getByRole("link").getAttribute("href")).toBe("/app/opponents?notes=1");
  fireEvent.click(screen.getByRole("button")); expect(router.push).toHaveBeenCalledWith("/app/opponents?notes=1"); expect(router.back).not.toHaveBeenCalled();
});
