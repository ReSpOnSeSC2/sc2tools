import { buttonClassName } from "@/components/ui/buttonStyles";
import { Card } from "@/components/ui/Card";
import { discordBuildInstallUrl } from "@/lib/discordBuildInstall";

export function DiscordBuildInstall({ applicationId }: { applicationId?: string }) {
  const href = discordBuildInstallUrl(applicationId);
  return (
    <Card title="Add to a server" headingLevel={2}>
      {href
        ? <a href={href} className={buttonClassName()}>Add to Discord</a>
        : <p className="text-text-muted">Discord installation is currently unavailable.</p>}
    </Card>
  );
}
