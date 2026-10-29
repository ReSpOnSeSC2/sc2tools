/** The owner-selected mobile overview; 48px roster targets remain 24px. */
export const MACRO_OVERVIEW_SCALE = 0.5;

export function macroOverviewLayout(width: number) {
  return { logicalWidth: width / MACRO_OVERVIEW_SCALE, scale: MACRO_OVERVIEW_SCALE };
}
