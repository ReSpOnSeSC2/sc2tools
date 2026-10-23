import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DownloadInteractive } from "./DownloadInteractive";
vi.mock("./usePlatformDetect", () => ({ usePlatformDetect: () => "windows" }));
vi.mock("./useIsMobileDevice", () => ({ useIsMobileDevice: () => false }));
vi.mock("./useReleaseInfo", () => ({ useReleaseInfo: () => ({ isLoading: false, error: null, data: { artifact: null } }), formatBytes: () => "unknown" }));
afterEach(cleanup);
it("switches the complete source-install instructions with the selected OS and avoids a guessed size", () => {
  render(<DownloadInteractive />);
  const summary = screen.getByText("Manual install + verification").closest("summary")!; fireEvent.click(summary);
  const manual = within(summary.closest("details")!);
  const snippet = () => manual.getByText(/git clone/, { selector: "pre" }).textContent!;
  expect(snippet()).toContain("py -m venv .venv"); expect(snippet()).toContain(".venv\\Scripts\\activate");
  for (const os of ["macOS", "Linux"]) {
    fireEvent.click(screen.getByRole("tab", { name: os }));
    expect(snippet()).toContain("python3 -m venv .venv"); expect(snippet()).toContain("source .venv/bin/activate"); expect(snippet()).not.toContain("Scripts");
  }
  expect(document.body.textContent).not.toContain("217 MB"); expect(screen.getByText(/Installer size is shown when release information is available/)).toBeTruthy();
});
