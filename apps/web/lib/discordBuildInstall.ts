export const DISCORD_BUILD_HELP_SLUG = "discord-build-command";

/** The site owner supplies this public ID after verifying the server install. */
export function discordBuildInstallUrl(applicationId: string | undefined): string | null {
  if (!applicationId || !/^[1-9][0-9]{16,19}$/u.test(applicationId)) return null;
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", applicationId);
  url.searchParams.set("scope", "applications.commands");
  url.searchParams.set("integration_type", "0");
  return url.toString();
}
