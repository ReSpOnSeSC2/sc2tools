import { describe, expect, it } from "vitest";
import { getArticle } from "@/lib/help";
import { DISCORD_BUILD_HELP_SLUG, discordBuildInstallUrl } from "@/lib/discordBuildInstall";

describe("Discord build command help", () => {
  it("is public and links back to build guides", () => {
    const article = getArticle(DISCORD_BUILD_HELP_SLUG);
    expect(article?.category).toBe("builds");
    expect(article?.signedInOnly).toBeUndefined();
    expect(article?.related).toContain("build-guides");
  });

  it("requires the published owner ID and requests only guild application commands", () => {
    for (const id of [undefined, "", "0", "012345678901234567", "https://discord.com/", "123456789012345678&scope=bot"]) {
      expect(discordBuildInstallUrl(id)).toBeNull();
    }
    const url = new URL(discordBuildInstallUrl("123456789012345678")!);
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "123456789012345678", scope: "applications.commands", integration_type: "0",
    });
  });
});
