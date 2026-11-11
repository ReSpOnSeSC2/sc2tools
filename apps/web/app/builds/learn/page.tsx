import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";

export const metadata = {
  title: "Randomize your practice",
  description: "Set a StarCraft II build pool, draw a build on the desktop and track your challenge.",
  alternates: { canonical: "/builds/learn" },
};

export default function BuildsLearnPage() {
  return <div className="mx-auto max-w-3xl space-y-6">
    <PageHeader eyebrow="Build library" title="Practice with your build library" />
    <Section id="randomize-your-practice" title="Randomize your practice"
      description="Draw a build from a saved pool and work through the openers you want to practice.">
      <Card className="space-y-4">
        <ol className="list-decimal space-y-3 pl-5 text-body text-text">
          <li>Open Randomizer settings, select a matchup and enable a pool of builds you want to play.</li>
          <li>Turn on the desktop draw for games without a connected randomizer source. In the loading card, choose Play it to declare the saved pick or Reroll for one alternate.</li>
          <li>Open the Randomizer challenge in Practice to see the rolls, your matching confirmed check-ins and how much of your pool you have played.</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/settings?tab=randomizer">Set up randomizer</LinkButton>
          <LinkButton href="/practice#randomizer-challenge" variant="secondary">Open your challenge</LinkButton>
        </div>
      </Card>
    </Section>
  </div>;
}
