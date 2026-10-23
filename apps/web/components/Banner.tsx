import Image from "next/image";

/** Decorative brand divider; product screenshots introduce the landing page. */
export function Banner({ variant = "divider" }: { variant?: "divider" }) { void variant; return <DividerBanner />; }

const LOGO_PATH = "/logo.png";

function DividerBanner() {
  return (
    <div
      className="relative my-12 flex items-center gap-4"
      role="presentation"
      aria-hidden
    >
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-accent/60 to-accent/80" />
      <Image
        src={LOGO_PATH}
        alt=""
        width={56}
        height={56}
        className="flex-shrink-0 rounded-full opacity-90 shadow-halo-cyan"
      />
      <span className="h-px flex-1 bg-gradient-to-l from-transparent via-accent/60 to-accent/80" />
    </div>
  );
}
