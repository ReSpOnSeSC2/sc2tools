import type { Metadata } from "next";
import { LearnPage } from "@/components/stream-studio/LearnPage";
import { pageMetadata } from "@/lib/seo/pageMetadata";

const TITLE = "Learn Stream Studio: widget guides & OBS crash course | SC2 Tools";
const DESCRIPTION = "Build your first StarCraft II stream overlay with a five-lesson crash course, setup guides for every widget, suggested starter scenes and practical troubleshooting.";

export const metadata: Metadata = {
  ...pageMetadata({ title: TITLE, description: DESCRIPTION, canonical: "/stream-studio/learn", shareTitle: TITLE }),
  title: { absolute: TITLE },
};

export default function StreamStudioLearnRoute() {
  return <LearnPage />;
}
