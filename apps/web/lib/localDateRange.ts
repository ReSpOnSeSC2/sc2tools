/** Calendar dates use the player's local timezone, including daylight saving changes. */
function localDate(value: string, next: boolean): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("Invalid calendar date");
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) throw new Error("Invalid calendar date");
  if (next) date.setDate(date.getDate() + 1);
  return date.toISOString();
}
export const localDayStartIso = (value: string): string => localDate(value, false);
export const localNextDayStartIso = (value: string): string => localDate(value, true);
