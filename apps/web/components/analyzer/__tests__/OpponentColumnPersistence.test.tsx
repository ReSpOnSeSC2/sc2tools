import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { opponentColumns, type OpponentColumns } from "@/lib/opponentPresentation";
import { OpponentColumnPicker } from "../opponents/OpponentHistory";

const key = "analyzer.opponents.columns";
afterEach(() => { cleanup(); localStorage.removeItem(key); });

// Exercise the real picker and storage hook; API and account loading are
// outside this fixture. These overrides are also used by OpponentsTab.
function SavedColumns() {
  const [overrides, save] = useLocalStorageState<Partial<OpponentColumns>>(key, {});
  return <OpponentColumnPicker columns={opponentColumns(overrides, true)} onChange={(column, visible) => save({ ...overrides, [column]: visible })} onReset={() => save({})} />;
}

it("restores real column controls in StrictMode and saves a click before leaving the page", () => {
  const saved = { pulseId: true, mmr: false };
  localStorage.setItem(key, JSON.stringify(saved));
  const view = render(<StrictMode><SavedColumns /></StrictMode>);
  expect((screen.getByLabelText("Pulse ID") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText("Last MMR") as HTMLInputElement).checked).toBe(false);
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(saved);
  fireEvent.click(screen.getByLabelText("MMR won"));
  view.unmount();
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ ...saved, mmrWon: true });
  render(<StrictMode><SavedColumns /></StrictMode>);
  expect((screen.getByLabelText("MMR won") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText("Last MMR") as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Reset columns", hidden: true }));
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({});
});
