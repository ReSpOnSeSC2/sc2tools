import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AttentionCard } from "./AttentionCard";
import { sanitizeMapPlayback } from "@/lib/mapReplay";

vi.mock("@/components/maps/MapArtwork", () => ({ MapArtwork: () => null }));

const fixture = {
  v: 7, mapName: "Test", gameLength: 10,
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  units: [], buildings: [{ t: 0, x: 10, y: 10, owner: "me", name: "Nexus" }],
};

it("offers full replay attention from a section without camera data", async () => {
  const early = sanitizeMapPlayback(fixture)!;
  const late = sanitizeMapPlayback({ ...fixture, camera: { me: [5, 10, 10] } })!;
  async function* readAll() {
    yield { start: 0, end: 5, playback: early };
    yield { start: 5, end: 10, playback: late };
  }
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  try {
    render(<AttentionCard playback={early} start={0} end={5} readAll={readAll} />);
    const details = screen.getByText("Camera attention").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText("No camera samples for this side in the loaded section.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Analyze full replay" }));
    expect(await screen.findByText("Full replay")).toBeTruthy();
    expect(screen.getByText(/5 camera samples/)).toBeTruthy();
  } finally {
    canvas.mockRestore();
  }
});
