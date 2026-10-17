import type { Metadata } from "next";
import { LearnPage } from "@/components/stream-studio/LearnPage";

const TITLE = "Learn Stream Studio: widget guides & OBS crash course | SC2 Tools";
const DESCRIPTION = "Build your first StarCraft II stream overlay with a five-lesson crash course, setup guides for every widget, suggested starter scenes and practical troubleshooting.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/stream-studio/learn" },
  openGraph: { type: "website", siteName: "SC2 Tools", url: "/stream-studio/learn", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

export default function StreamStudioLearnRoute() {
  return <LearnPage />;
}
