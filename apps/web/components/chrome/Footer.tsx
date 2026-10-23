import Link from "next/link";
import type { ReactNode } from "react";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { ExternalLink } from "lucide-react";
import { ReportIssueLauncher } from "@/components/feedback/ReportIssueLauncher";
import { guidesEnabled } from "@/lib/guides/flags";
import { getInstantImportMode } from "@/lib/instant/flag";
import { LogoMark } from "./LogoMark";
import { CookieSettingsButton } from "@/components/legal/CookieSettingsButton";

/**
 * Footer — three-column site footer.
 *
 *   - Desktop (≥lg): brand strip + 3 link columns in a 4-up grid
 *   - Tablet (md): brand strip on top, link columns below in 3 cols
 *   - Mobile (<md): single column stack
 *
 * The status link points at the public status page; it lives in the
 * Legal column so it travels with the smaller-text utility links and
 * doesn't compete with the primary product links. It is a plain link,
 * not a health light: the footer has no live status to show.
 *
 * Links meant for one audience (Devices for signed-in players, Sign in
 * for visitors) render inside the matching Clerk gate, so a visitor
 * never follows a footer link into a sign-in wall.
 */

export interface FooterLink {
  href: string;
  label: string;
  external?: boolean;
  /** "in": signed-in players only. "out": signed-out visitors only. */
  auth?: "in" | "out";
}

const TRY_LINK: FooterLink = { href: "/try", label: "Analyze replays in your browser" };

const PRODUCT_LINKS: readonly FooterLink[] = [
  { href: "/#analyze", label: "Analyze" },
  { href: "/#practice", label: "Practice" },
  // The dedicated page (SEO landing for "sc2 overlay"), not the homepage anchor.
  { href: "/stream-studio", label: "Stream Studio" },
  { href: "/builds", label: "Build library" },
  { href: "/devices", label: "Devices", auth: "in" },
  { href: "/download", label: "Download agent" },
];

/** The public status page (an external site). */
export const STATUS_PAGE_URL = "https://status.sc2tools.com";

/** The site owner's channel, where the build-order videos are published. */
export const YOUTUBE_CHANNEL_URL = "https://www.youtube.com/@ReSpOnSeSC2";

const GUIDES_LINK: FooterLink = { href: "/guides", label: "Build guides" };

const RESOURCES_LINKS: readonly FooterLink[] = [
  { href: "/stream-studio/learn", label: "Stream Studio crash course" },
  { href: YOUTUBE_CHANNEL_URL, label: "YouTube build videos", external: true },
  { href: "/community", label: "Community" },
  { href: "/help", label: "Help" },
  { href: "/help/getting-started", label: "Getting started" },
  { href: "/donate", label: "Donate / support" },
  { href: "/sign-in", label: "Sign in", auth: "out" },
];

const LEGAL_LINKS: readonly FooterLink[] = [
  { href: "/legal/privacy", label: "Privacy" },
  { href: "/legal/terms", label: "Terms" },
];

/** Resources column; "Build guides" only while the guides flag is on. */
export function resourcesLinks(guides: boolean): readonly FooterLink[] {
  return guides ? [GUIDES_LINK, ...RESOURCES_LINKS] : RESOURCES_LINKS;
}

/**
 * Product column; the in-browser analyzer (/try) right after "Analyze"
 * while Instant Analysis is open to everyone.
 */
export function productLinks(tryPage: boolean): readonly FooterLink[] {
  return tryPage ? [PRODUCT_LINKS[0], TRY_LINK, ...PRODUCT_LINKS.slice(1)] : PRODUCT_LINKS;
}

export function Footer() {
  return (
    <footer className="mt-16 border-t border-border bg-bg-surface/40">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-12">
        <div className="grid gap-10 md:grid-cols-3 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <BrandStrip />
          <FooterColumn
            title="Product"
            links={productLinks(getInstantImportMode() === "all")}
          />
          <FooterColumn
            title="Resources"
            links={resourcesLinks(guidesEnabled())}
            trailing={<ReportIssueLauncher />}
          />
          <FooterColumn
            title="Legal"
            links={LEGAL_LINKS}
            trailing={<CookieSettingsButton />}
            extra={<StatusBadge />}
          />
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t border-border pt-6 text-caption text-text-dim sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} SC2 Tools. All rights reserved.</p>
          <p>
            StarCraft II and map artwork © Blizzard Entertainment. SC2 Tools
            is not affiliated with or endorsed by Blizzard Entertainment.
          </p>
        </div>
      </div>
    </footer>
  );
}

function BrandStrip() {
  return (
    <div>
      <Link
        href="/"
        aria-label="SC2 Tools — home"
        className="group inline-flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <LogoMark
          size={32}
          className="motion-safe:transition-shadow motion-safe:duration-150 group-hover:shadow-[0_0_18px_var(--halo-cyan)]"
        />
        <span className="text-h4 font-semibold tracking-tight text-text">
          SC2 Tools
        </span>
      </Link>
      <p className="mt-3 max-w-xs text-caption text-text-muted">
        Replay analysis, opponent intel, build coaching, and a complete Stream
        Studio for StarCraft II.
      </p>
    </div>
  );
}

interface FooterColumnProps {
  title: string;
  links: readonly FooterLink[];
  extra?: ReactNode;
  /** Optional interactive item appended as the last list entry (e.g. the report-a-bug launcher). */
  trailing?: ReactNode;
}

function FooterColumn({ title, links, extra, trailing }: FooterColumnProps) {
  return (
    <div>
      <h3 className="text-micro font-semibold uppercase tracking-[0.12em] text-text-dim">
        {title}
      </h3>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <FooterLinkGate key={link.href} auth={link.auth}>
            <li>
              {link.external ? (
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`gap-1 ${FOOTER_LINK_CLS}`}
                >
                  {link.label}
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : (
                <Link href={link.href} className={FOOTER_LINK_CLS}>
                  {link.label}
                </Link>
              )}
            </li>
          </FooterLinkGate>
        ))}
        {trailing ? <li>{trailing}</li> : null}
      </ul>
      {extra ? <div className="mt-4">{extra}</div> : null}
    </div>
  );
}

const FOOTER_LINK_CLS =
  "inline-flex min-h-[28px] items-center text-caption text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm";

function FooterLinkGate({ auth, children }: { auth?: FooterLink["auth"]; children: ReactNode }) {
  if (auth === "in") return <SignedIn>{children}</SignedIn>;
  if (auth === "out") return <SignedOut>{children}</SignedOut>;
  return <>{children}</>;
}

function StatusBadge() {
  return (
    <a
      href={STATUS_PAGE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-[28px] items-center gap-1.5 rounded-full border border-border bg-bg-elevated px-2.5 py-1 text-micro font-medium text-text-muted hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      System status
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
