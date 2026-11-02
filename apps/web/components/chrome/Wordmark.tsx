/**
 * The display-face "SC2 Tools" wordmark with its accent tick, shared by the
 * site header, the mobile drawer, the footer and the app rail. `md` sits beside
 * a 28-32 px mark; `sm` fits the rail's compact label. Decorative text inside a
 * link that is already labelled "SC2 Tools — home".
 *
 * Example: <Wordmark className="group-hover:text-accent" />
 */
export function Wordmark({ size = "md", className = "" }: { size?: "sm" | "md"; className?: string }) {
  return (
    <span className={["flex items-center gap-1.5 font-display font-extrabold tracking-tight text-text",
      size === "sm" ? "text-caption" : "text-h4", className].filter(Boolean).join(" ")}>
      SC2&nbsp;Tools
      <span aria-hidden className={`${size === "sm" ? "h-1 w-1" : "h-1.5 w-1.5"} rounded-full bg-accent`} />
    </span>
  );
}
