import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { deriveReplayHud } from "@/lib/replayHud";
import { ProductionRail, type ProductionTab } from "../ProductionRail";
import { payload } from "./fixtures";
afterEach(cleanup);
function Harness() {
  const [tab, setTab] = useState<ProductionTab>("queue"); const replay = payload();
  return <ProductionRail playback={replay} model={deriveReplayHud(replay)} side="me" t={100}
    tab={tab} onTabChange={setTab} onSideChange={() => undefined} />;
}
it("moves selection and focus with arrows and Home/End", () => {
  render(<Harness />);
  const queue = screen.getByRole("tab", { name: "Queue" }); const field = screen.getByRole("tab", { name: "On Field" });
  expect(queue.tabIndex).toBe(0); expect(field.tabIndex).toBe(-1);
  queue.focus(); fireEvent.keyDown(queue, { key: "ArrowRight" });
  expect(document.activeElement).toBe(field); expect(field.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(field, { key: "ArrowRight" }); expect(document.activeElement).toBe(queue);
  fireEvent.keyDown(queue, { key: "End" }); expect(document.activeElement).toBe(field);
  fireEvent.keyDown(field, { key: "Home" }); expect(document.activeElement).toBe(queue);
});
