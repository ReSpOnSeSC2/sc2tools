import { expect, it } from "vitest";
import { clearCommunityFilters, communityHref, parseCommunityQuery } from "./communityQuery";

it("round-trips known filters, ignores invalid values and tolerates duplicate parameter arrays", () => {
  const query = parseCommunityQuery({ race: "P", vs: "Z", skill: "diamond", sort: "updated", q: " blink ", offset: "24" });
  expect(communityHref(query)).toBe("/community?race=P&vs=Z&skill=diamond&sort=updated&q=blink&offset=24");
  expect(parseCommunityQuery({ race: "Random", vs: ["P", "T"], skill: "professional", sort: "drop", q: ["x"], offset: "-7" })).toEqual({ race: "", vs: "", skill: "", sort: "top", search: "", offset: 0 });
  expect(communityHref(clearCommunityFilters(query))).toBe("/community?sort=updated");
});

it("understands legacy matchups while explicit new race choices win", () => {
  expect(parseCommunityQuery({ matchup: "PvZ" })).toMatchObject({ race: "P", vs: "Z" });
  expect(parseCommunityQuery({ matchup: "PvZ", race: "T" })).toMatchObject({ race: "T", vs: "Z" });
  expect(parseCommunityQuery({ matchup: "<PvZ>" })).toMatchObject({ race: "", vs: "" });
});

it("keeps Mine separate from all public filters and only accepts its explicit flag", () => {
  expect(communityHref(parseCommunityQuery({ mine: "1", race: "P", q: "old", offset: "24" }))).toBe("/community?mine=1");
  expect(parseCommunityQuery({ mine: ["1"] }).mine).toBeUndefined();
  expect(parseCommunityQuery({ mine: "true" }).mine).toBeUndefined();
});
