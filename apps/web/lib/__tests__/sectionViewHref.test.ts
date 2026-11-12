import { expect, it } from "vitest";
import { sectionViewHref } from "../sectionViewHref";
it("copies replay paging and filters while excluding unrelated credentials", () => {
  const url = new URL(sectionViewHref("/app/replays", "q=Gateway&result=loss&cursor=page2&before=2026-10-10&token=private&unrelated=x", { race: "P", accounts: "1-S2-1-2" }), "https://fixture.test");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: "Gateway", result: "loss", cursor: "page2", before: "2026-10-10", race: "P", accounts: "1-S2-1-2", filters: "1" });
  expect(url.searchParams.has("token")).toBe(false); expect(url.searchParams.has("unrelated")).toBe(false);
});
it("keeps older replay and opponent links on the same displayed section state", () => {
  expect(new URL(sectionViewHref("/app/replays", "replaySearch=Old&replayResult=win", {}), "https://fixture.test").searchParams.get("q")).toBe("Old");
  expect(new URL(sectionViewHref("/app/opponents", "sort=name&dir=asc", {}), "https://fixture.test").searchParams.get("sort")).toBe("name:asc");
});
it("copies an old opponent filter under its new key without changing other sections", () => {
  const origin = "https://fixture.test";
  const opponents = new URL(sectionViewHref("/app/opponents", "q=Legacy+Fixture&cursor=page2&token=private", {}), origin);
  expect(Object.fromEntries(opponents.searchParams)).toMatchObject({ opponentFilter: "Legacy Fixture", cursor: "page2" });
  expect(opponents.searchParams.has("q")).toBe(false);
  expect(opponents.searchParams.has("token")).toBe(false);
  const replays = new URL(sectionViewHref("/app/replays", "q=Replay&opponentFilter=Fixture", {}), origin);
  expect(replays.searchParams.get("q")).toBe("Replay");
  expect(replays.searchParams.has("opponentFilter")).toBe(false);
});
it.each(["opponentFilter=New+Fixture&q=Legacy", "opponentFilter=&q=Legacy", "opponentFilter=First&opponentFilter=Second&q=Legacy"])(
  "copies a new opponent filter only when its supplied value is unambiguous (%s)", query => {
    const params = new URL(sectionViewHref("/app/opponents", query, {}), "https://fixture.test").searchParams;
    expect(params.has("q")).toBe(false);
    expect(params.get("opponentFilter")).toBe(query.startsWith("opponentFilter=New") ? "New Fixture" : null);
  },
);
