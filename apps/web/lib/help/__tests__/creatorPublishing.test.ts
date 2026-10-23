import { expect, it } from "vitest";
import { getArticle, helpArticleAnchors } from "../index";

it("keeps publishing entry points linked to the owner/privacy and update instructions", () => {
  const article = getArticle("publish-community-builds")!;
  expect(helpArticleAnchors(article)).toEqual(expect.arrayContaining(["publish-from-community", "named-vs-anonymous", "my-published-builds", "update-or-remove"]));
  const body = JSON.stringify(article.body);
  expect(body).toContain("anonymous builds never join your author profile");
  expect(body).toContain("visible only to you"); expect(body).toContain("classified replays");
  expect(body).toContain("keeps both confirmation steps"); expect(body).toContain("Publish update");
});
