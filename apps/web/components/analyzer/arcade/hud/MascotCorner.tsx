"use client";

/**
 * MascotCorner — a tiny SVG mascot in the bottom corner of the Today
 * surface that reflects whether the user has played today. Skin is
 * driven by ArcadeState.cosmetics.mascotSkin so cosmetic purchases
 * actually change something.
 */
export function MascotCorner({
  skin,
  played,
}: {
  skin: string;
  played: boolean;
}) {
  const isFoil = skin === "foil";
  const tint = played ? "text-success" : "text-text-dim";
  return (
    <span
      aria-hidden
      className={[
        "pointer-events-none absolute bottom-3 right-3 hidden sm:inline-flex",
        tint,
      ].join(" ")}
    >
      <svg
        viewBox="0 0 48 48"
        width={36}
        height={36}
        className={isFoil ? "drop-shadow-[0_0_8px_rgba(125,200,255,0.6)]" : ""}
      >
        <title>Arcade mascot</title>
        <circle cx="24" cy="24" r="20" fill="currentColor" opacity="0.12" />
        <circle cx="24" cy="22" r="11" fill="currentColor" opacity="0.4" />
        <circle cx="20" cy="20" r="2" fill="currentColor" />
        <circle cx="28" cy="20" r="2" fill="currentColor" />
        <path
          d="M18 27 Q24 32 30 27"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
