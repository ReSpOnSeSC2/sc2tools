import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CheckpointEditor } from "../CheckpointEditor";

const mocks = vi.hoisted(() => ({ apiCall: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: vi.fn() }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: mocks.apiCall }));
afterEach(() => { cleanup(); mocks.apiCall.mockReset(); });

it("saves an edited tolerance with the previous rules and shows the hit rate", async () => {
  const onSaved = vi.fn();
  const hash = "0123456789abcdef";
  mocks.apiCall.mockResolvedValue({ checkpoints: [{ i: 0, toleranceSec: 20 }] });
  render(<CheckpointEditor matchup="PvZ" targetHash={hash} onSaved={onSaved}
    steps={[{ i: 0, name: "Pylon", t: 18, supply: null }]}
    checkpoints={[{ i: 0, name: "Pylon", toleranceSec: 10, attempts: 4, hits: 3 }]} />);
  expect(screen.getByText("3 of 4 on time (75%)")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Tolerance 1 (s)"), { target: { value: "20" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save checkpoints" }).closest("form")!);
  expect(await screen.findByText("Checkpoints saved.")).toBeTruthy();
  expect(onSaved).toHaveBeenCalledOnce();
  const [, path, options] = mocks.apiCall.mock.calls[0];
  expect(path).toBe("/v1/practice/checkpoints");
  expect(options.method).toBe("PUT");
  expect(JSON.parse(options.body)).toEqual({ matchup: "PvZ", targetHash: hash, expected: [{ i: 0, toleranceSec: 10 }], checkpoints: [{ i: 0, toleranceSec: 20 }] });
});
