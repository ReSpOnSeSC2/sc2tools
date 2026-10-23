import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BuildDefinitionCard } from "./BuildDefinitionCard";
const build = { slug: "test", name: "Test build", race: "Protoss" as const };
afterEach(cleanup);
it("reads rules, strategy chips and skill level, with an editor action", () => {
  const edit = vi.fn();
  render(<BuildDefinitionCard build={{ ...build, rules: [{ type: "before", name: "BuildGateway", time_lt: 90 }], winConditions: ["Early pressure"], transitionsInto: ["Carrier"], skillLevel: "diamond" }} onEdit={edit} />);
  expect(screen.getByRole("heading", { name: "Build definition" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Must have" })).toBeTruthy();
  expect(screen.getByText("Early pressure")).toBeTruthy();
  expect(screen.getByText("Carrier")).toBeTruthy();
  expect(screen.getByText("Diamond")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Loses to" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit build definition" }));
  expect(edit).toHaveBeenCalledTimes(1);
});
it("hides an empty definition and retains signature-only definitions", () => {
  const { container, rerender } = render(<BuildDefinitionCard build={build} onEdit={vi.fn()} />);
  expect(container.innerHTML).toBe("");
  rerender(<BuildDefinitionCard build={{ ...build, signature: [{ unit: "Gateway", count: 1, beforeSec: 90 }] }} onEdit={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Build definition" })).toBeTruthy();
  expect(screen.getByText(/Gateway/)).toBeTruthy();
});
