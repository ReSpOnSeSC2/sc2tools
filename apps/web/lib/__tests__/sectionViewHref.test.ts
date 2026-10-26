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
