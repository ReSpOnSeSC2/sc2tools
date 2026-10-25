import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useOverlayBuildIntents } from "../useRandomizerCheckin";

it("clears private saved picks on token changes and ignores old socket callbacks", () => {
  const view = renderHook(({ owner }) => useOverlayBuildIntents(owner), { initialProps: { owner: "owner-a" } });
  const previousHandler = view.result.current[1];
  act(() => previousHandler({ gameKey: "same-game", holdRemainingMs: 0,
    randomizer: { key: "custom:private-a", name: "Private A", source: "custom" } }));
  expect(view.result.current[0].get("same-game")?.randomizer?.name).toBe("Private A");
  view.rerender({ owner: "owner-b" });
  expect(view.result.current[0].size).toBe(0);
  act(() => previousHandler({ gameKey: "same-game", holdRemainingMs: 0,
    randomizer: { key: "custom:private-a", name: "Private A", source: "custom" } }));
  expect(view.result.current[0].size).toBe(0);
  view.rerender({ owner: "owner-a" });
  expect(view.result.current[0].size).toBe(0);
  view.unmount();
});
