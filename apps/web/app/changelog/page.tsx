import type { Metadata } from "next";
import Link from "next/link";
import { Changelog } from "@/components/announcements/Changelog";
import { PageHeader } from "@/components/ui/PageHeader";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { pageMetadata } from "@/lib/seo/pageMetadata";
import { AgentReleaseHistory } from "./AgentReleaseHistory";

const TITLE = "What's new";
export const dynamic = "force-static";
export const metadata: Metadata = {
  ...pageMetadata({ title: TITLE, description: "Recent improvements to SC2 Tools, the desktop app, Stream Studio and guides.", canonical: "/changelog" }),
  title: TITLE,
  alternates: {
    canonical: "/changelog",
    types: {
      "application/rss+xml": [
        { url: "/changelog/rss.xml", title: "Product updates" },
        { url: "/changelog/agent.xml", title: "Agent release notes" },
      ],
    },
  },
};

export default function ChangelogPage() {
  const linkStyle = buttonClassName({ variant: "ghost" });
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <PageHeader
        title={TITLE}
        description="Recent improvements, with a short guide to using each one."
        actions={<>
          <Link className={linkStyle} href="/changelog/rss.xml" prefetch={false}>RSS feed</Link>
          <a className={linkStyle} href="#agent-release-notes">Agent release notes</a>
          <LazyHelpLink slug="stay-up-to-date">Stay up to date</LazyHelpLink>
        </>}
      />
      <Changelog />
      <AgentReleaseHistory />
    </main>
  );
}
