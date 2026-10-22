import Image from "next/image";

/**
 * The round SC2 Tools mark used in the site and app chrome.
 *
 * Served from /logo-64.webp: a 64 px square crop of public/logo.png
 * (~2 KB instead of ~2 MB), sharp at 2x for every size the chrome uses
 * (24–32 px). It is already as small as it gets, so it skips the image
 * optimizer. public/logo.png stays for structured data and the large
 * Banner art.
 *
 * Decorative by default (`alt=""`): every use sits inside a link that is
 * already labelled "SC2 Tools — home".
 *
 * Example:
 *   <LogoMark size={28} priority />
 */
export const LOGO_MARK_SRC = "/logo-64.webp";

export interface LogoMarkProps {
  /** Rendered width and height in CSS px. */
  size: number;
  className?: string;
  /** Preload it: set on the one mark that is above the fold on first paint. */
  priority?: boolean;
}

export function LogoMark({ size, className = "", priority = false }: LogoMarkProps) {
  return (
    <Image
      src={LOGO_MARK_SRC}
      alt=""
      width={size}
      height={size}
      unoptimized
      priority={priority}
      className={["rounded-full", className].filter(Boolean).join(" ")}
    />
  );
}
