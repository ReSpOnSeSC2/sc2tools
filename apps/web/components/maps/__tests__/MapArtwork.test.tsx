import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MapArtwork, MapLabel } from "../MapArtwork";

describe("MapArtwork", () => {
  it("renders a lazy real image and keeps the map name as text", () => {
    const { container } = render(<MapLabel name="Ruby Rock" />);
    expect(screen.getByText("Ruby Rock")).toBeTruthy();
    const image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toContain("Ruby%20Rock%20LE");
    expect(image.getAttribute("loading")).toBe("lazy");
  });

  it("falls back locally when an image request fails", () => {
    const { container } = render(<MapArtwork mapName="Ruby Rock" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("[data-map-artwork='fallback']")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("never emits an image request for an unknown map", () => {
    const { container } = render(<MapLabel name="Unknown Test Map" />);
    expect(screen.getByText("Unknown Test Map")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});
