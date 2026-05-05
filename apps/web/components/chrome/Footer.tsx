import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";

/**
 * Footer — three-column site footer.
 *
 *   - Desktop (≥lg): brand strip + 3 link columns in a 4-up grid
 *   - Tablet (md): brand strip on top, link columns below in 3 cols
 *   - Mobile (<md): single column stack
 *
 * The status badge points at the public status page; it lives in the
 * Legal column so it travels with the smaller-text utility links and
 * doesn't compete with the primary product links.
 */

interface FooterLink {
  href: string;
  label: string;
  external?: boolean;
}

const PRODUCT_LINKS: readonly FooterLink[] = [
  { href: "/app", label: "Dashboard" },
  { href: "/builds", label: "Builds" },
  { href: "/settings#overlay", label: "Overlay" },
  { href: "/devices", label: "Devices" },
  { href: "/download", label: "Download agent" },
];

const RESOURCES_LINKS: readonly FooterLink[] = [
  { href: "/community", label: "Community" },
  { href: "/welcome", label: "Getting started" },
  { href: "/donate", label: "Donate / support" },
  { href: "/sign-in", label: "Sign in" },
];

const LEGAL_LINKS: readonly FooterLink[] = [
  { href: "/legal/privacy", label: "Privacy" },
  { href: "/legal/terms", label: "Terms" },
];

export function Footer() {
  return (
    <footer className="mt-16 border-t border-border bg-bg-surface/40">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-12">
        <div className="grid gap-10 md:grid-cols-3 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <BrandStrip />
          <FooterColumn title="Product" links={PRODUCT_LINKS} />
          <FooterColumn title="Resources" links={RESOURCES_LINKS} />
          <FooterColumn
            title="Legal"
            links={LEGAL_LINKS}
            extra={<StatusBadge />}
          />
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t border-border pt-6 text-caption text-text-dim sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} SC2 Tools. All rights reserved.</p>
          <p>
            Not affiliated with Blizzard Entertainment. StarCraft II is a
            trademark of its respective owners.
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
        <Image
          src="/logo.png"
          alt=""
          width={32}
          height={32}
          className="rounded-full motion-safe:transition-shadow motion-safe:duration-150 group-hover:shadow-[0_0_18px_var(--halo-cyan)]"
        />
        <span className="text-h4 font-semibold tracking-tight text-text">
          SC2 Tools
        </span>
      </Link>
      <p className="mt-3 max-w-xs text-caption text-text-muted">
        Real opponent intel for StarCraft II. No install ceremony — sign in,
        run the agent, and your opponents tab loads in seconds.
      </p>
    </div>
  );
}

interface FooterColumnProps {
  title: string;
  links: readonly FooterLink[];
  extra?: ReactNode;
}

function FooterColumn({ title, links, extra }: FooterColumnProps) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-dim">
        {title}
      </h3>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <li key={link.href}>
            {link.external ? (
              <a
                href={link.href}
                rel="noopener"
                className="inline-flex min-h-[28px] items-center text-caption text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
              >
                {link.label}
              </a>
            ) : (
              <Link
                href={link.href}
                className="inline-flex min-h-[28px] items-center text-caption text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
              >
                {link.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
      {extra ? <div className="mt-4">{extra}</div> : null}
    </div>
  );
}

function StatusBadge() {
  return (
    <a
      href="https://status.sc2tools.com"
      rel="noopener"
      className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-elevated px-2.5 py-1 text-[11px] font-medium text-text-muted hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="relative inline-flex h-2 w-2 items-center justify-center" aria-hidden>
        <span className="absolute inline-flex h-2 w-2 rounded-full bg-success opacity-60 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
      </span>
      Status
    </a>
  );
}
