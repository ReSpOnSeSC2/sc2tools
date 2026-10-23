import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { smartScreenNote } from "@/lib/agentInstallerCopy";
import { InstallOptions } from "./DownloadInteractive";

afterEach(cleanup);

it("explains startup, preservation and verification in an accessible expander", () => {
  render(<InstallOptions />);
  const summary = screen.getByText("Install, start-up and uninstall");
  const details = summary.closest("details");
  expect(details?.open).toBe(false);
  fireEvent.click(summary);
  expect(details?.open).toBe(true);
  expect(screen.getByText(/silent updates keep your choices/)).toBeTruthy();
  expect(screen.getByText(/original StarCraft II replay folders and cloud games are kept/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Installation and uninstall guide" }).getAttribute("href")).toBe("/help/desktop-app-install");
  expect(screen.getByText((text) => text.includes(smartScreenNote))).toBeTruthy();
});
