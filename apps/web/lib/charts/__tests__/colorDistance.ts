/** Regression model, not a clinical guarantee. CIE76 distance in D65 Lab:
 * https://cie.co.at/eilvterm/17-23-076 and /17-23-077.
 * Machado severity-1 deuteranopia matrix, rounded as Appendix A, Table A.1:
 * https://www.inf.ufrgs.br/~oliveira/students_dissertations/Masters/Gustavo_Machado_Masters_thesis_UFRGS_2010.pdf
 * Visible names, dash patterns and data tables remain necessary. */
const linear = (value: number) => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; };
export function lab(rgb: readonly number[], deuteranopia = false): number[] {
  let channels = rgb.map(linear);
  if (deuteranopia) channels = [[.367, .861, -.228], [.280, .673, .047], [-.012, .043, .969]]
    .map(row => Math.max(0, Math.min(1, row.reduce((sum, value, index) => sum + value * channels[index], 0))));
  const f = [[.4124564, .3575761, .1804375], [.2126729, .7151522, .072175], [.0193339, .119192, .9503041]]
    .map((row, index) => row.reduce((sum, value, i) => sum + value * channels[i], 0) / [.95047, 1, 1.08883][index])
    .map(value => value > (6 / 29) ** 3 ? Math.cbrt(value) : value / (3 * (6 / 29) ** 2) + 4 / 29);
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}
export function deltaE(a: readonly number[], b: readonly number[], deuteranopia = false) {
  const first = lab(a, deuteranopia), second = lab(b, deuteranopia);
  return Math.hypot(...first.map((value, index) => value - second[index]));
}
