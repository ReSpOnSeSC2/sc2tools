import { createRoot } from "react-dom/client";
import { PracticeLinkTabs } from "@/components/practice/PracticeLinkTabs";
import { PageHeader } from "@/components/ui/PageHeader";
import { fixtureTarget } from "./practice-link-session";

const title = "Gateway pressure";
const creator = "Fixture creator";
const hasSteps = !new URLSearchParams(location.search).has("empty");
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-5xl space-y-5 p-4">
    <PageHeader title={title} eyebrow="Practice Link" description={`Build by ${creator}`} />
    <PracticeLinkTabs videoId="1234567890_" offset={30} title={title} drill={hasSteps ? fixtureTarget : null} grade={hasSteps ? fixtureTarget : null}
      steps={hasSteps ? fixtureTarget.steps.map(step => ({ t: step.t, supply: step.supply, action: step.name })) : []}
      race="Protoss" era="before" gradeEnabled credit={{ title, creator, path: "/b/fixture" }} />
  </main>,
);
