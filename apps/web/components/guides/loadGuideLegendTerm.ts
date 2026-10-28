/** Keep the existing Term/InfoTip code behind an explicit legend expansion. */
export function loadGuideLegendTerm() {
  return import("@/components/ui/Term").then(({ Term }) => Term);
}
