import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { HELP_SUPPORT_EMAIL } from "@/lib/help/support";

const title = "Accessibility · SC2 Tools";
const description = "Our accessibility target, keyboard and appearance controls, known limits and how to report a barrier in SC2 Tools.";
export const metadata: Metadata = {
  title: "Accessibility", description, alternates: { canonical: "/legal/accessibility" },
  openGraph: { title, description, url: "/legal/accessibility", images: ["/og.jpg"] },
  twitter: { card: "summary_large_image", title, description, images: ["/og.jpg"] },
};

export default function AccessibilityPage() {
  return <article className="mx-auto max-w-3xl space-y-8">
    <PageHeader title="Accessibility" description="We want replay analysis and community knowledge to be usable by more players." />
    <section className="space-y-3" aria-labelledby="accessibility-target"><h2 id="accessibility-target" className="text-h2 font-semibold">Our target</h2>
      <p>We aim for <a href="https://www.w3.org/TR/WCAG22/" className="underline">WCAG 2.2 Level AA</a>. We check shared color tokens, public pages and keyboard interactions as part of development. Automated checks cover only part of accessibility; this statement is a target and an account of current support, not a claim that every screen meets every criterion.</p>
    </section>
    <section className="space-y-3" aria-labelledby="accessibility-keyboard"><h2 id="accessibility-keyboard" className="text-h2 font-semibold">Keyboard and appearance</h2>
      <p>Use Tab and Shift+Tab to move between controls, Enter to follow links, and Enter or Space to press buttons. The skip link moves to the main content. Escape closes supported menus and dialogs; focus returns to their opening control.</p>
      <p>Appearance offers Light, Dark and System. System follows changes to your device preference. The site also respects reduced-motion settings. <Link href="/help/appearance" className="underline">Read the appearance and keyboard guide</Link>.</p>
    </section>
    <section className="space-y-3" aria-labelledby="accessibility-limits"><h2 id="accessibility-limits" className="text-h2 font-semibold">Known limits</h2>
      <p>The replay map and some charts communicate spatial information visually. Their surrounding text, controls and recorded event lists offer another way to inspect parts of a game, but do not describe every visual event. OBS overlays are broadcast visuals and have different interaction constraints from the website. Embedded video players and account forms can also depend on a third-party provider.</p>
      <p>We continue improving these areas. A successful automated scan does not establish complete support for every screen reader, browser or input device.</p>
    </section>
    <section className="space-y-3" aria-labelledby="accessibility-report"><h2 id="accessibility-report" className="text-h2 font-semibold">Report a barrier</h2>
      <p>Use Help &amp; support → Report a problem when signed in, or <a href={`mailto:${HELP_SUPPORT_EMAIL}`} className="underline">email support</a>. Include the page, the control or task that was blocked, your browser and any assistive technology you used. You do not need an account to email us. Avoid including private replay data or access tokens.</p>
    </section>
  </article>;
}
