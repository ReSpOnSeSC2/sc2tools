import { OVERLAY_CREDIT_URL } from "./overlayCredit";

// Model 2, version 2, level Q, byte mode, mask 0. The fixed destination
// fits one block, so the encoder needs no version or interleaving tables.
const SIZE = 25;
const DATA_WORDS = 22;
const PARITY_WORDS = 22;
const FORMAT = 0x355f; // BCH-encoded level Q and mask 0.
export const OVERLAY_CREDIT_QR_QUIET_ZONE = 4;
export const OVERLAY_CREDIT_QR_SIZE = SIZE + 2 * OVERLAY_CREDIT_QR_QUIET_ZONE;

type Matrix = (boolean | null)[][];

function dataWords(): number[] {
  const bytes = new TextEncoder().encode(OVERLAY_CREDIT_URL);
  // Mode, character count and four terminating bits consume 16 bits.
  if (bytes.length > DATA_WORDS - 2) throw new RangeError("Overlay credit URL exceeds QR capacity.");
  const words = [0x40 | (bytes.length >> 4)];
  let pending = (bytes.length & 0xf) << 4;
  for (const byte of bytes) {
    words.push(pending | (byte >> 4));
    pending = (byte & 0xf) << 4;
  }
  words.push(pending);
  for (let pad = 0; words.length < DATA_WORDS; pad++) words.push(pad % 2 ? 0x11 : 0xec);
  return words;
}

/** Multiply in the QR Reed-Solomon field, modulo x⁸ + x⁴ + x³ + x² + 1. */
function fieldMultiply(a: number, b: number): number {
  let product = 0;
  while (b) {
    if (b & 1) product ^= a;
    a = (a << 1) ^ (a & 0x80 ? 0x11d : 0);
    b >>>= 1;
  }
  return product;
}

function addParity(data: number[]): number[] {
  let generator = [1];
  for (let degree = 0, root = 1; degree < PARITY_WORDS; degree++, root = fieldMultiply(root, 2)) {
    const next = [...generator, 0];
    for (const [i, coefficient] of generator.entries()) next[i + 1] ^= fieldMultiply(coefficient, root);
    generator = next;
  }
  const remainder = [...data, ...new Array<number>(PARITY_WORDS).fill(0)];
  for (let i = 0; i < data.length; i++) {
    for (let j = 1; j < generator.length; j++) remainder[i + j] ^= fieldMultiply(remainder[i], generator[j]);
  }
  return [...data, ...remainder.slice(data.length)];
}

function drawFinder(matrix: Matrix, x: number, y: number): void {
  for (let row = Math.max(0, y - 4); row <= Math.min(y + 4, SIZE - 1); row++) {
    for (let column = Math.max(0, x - 4); column <= Math.min(x + 4, SIZE - 1); column++) {
      const distance = Math.max(Math.abs(row - y), Math.abs(column - x));
      matrix[row][column] = distance !== 2 && distance !== 4;
    }
  }
}

function drawFormat(matrix: Matrix): void {
  const firstCopy = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (const [i, [x, y]] of firstCopy.entries()) {
    const dark = Boolean((FORMAT >> i) & 1);
    matrix[y][x] = dark;
    if (i < 8) matrix[8][SIZE - 1 - i] = dark;
    else matrix[SIZE - 15 + i][8] = dark;
  }
  matrix[SIZE - 8][8] = true;
}

function functionPatterns(): Matrix {
  const matrix = Array.from({ length: SIZE }, () => new Array<boolean | null>(SIZE).fill(null));
  for (let i = 0; i < SIZE; i++) matrix[6][i] = matrix[i][6] = i % 2 === 0;
  drawFinder(matrix, 3, 3);
  drawFinder(matrix, SIZE - 4, 3);
  drawFinder(matrix, 3, SIZE - 4);
  // Version 2 has one alignment pattern clear of the three finders.
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) matrix[18 + y][18 + x] = Math.max(Math.abs(x), Math.abs(y)) !== 1;
  }
  drawFormat(matrix);
  return matrix;
}

function placeWords(matrix: Matrix, words: readonly number[]): void {
  let bit = 0;
  for (let right = SIZE - 1; right > 0; right -= 2) {
    if (right === 6) right--; // Skip the timing column.
    const upwards = ((right + 1) & 2) === 0;
    for (let row = 0; row < SIZE; row++) {
      const y = upwards ? SIZE - 1 - row : row;
      for (const x of [right, right - 1]) {
        if (matrix[y][x] !== null) continue;
        // The seven remainder bits follow the last codeword as zeros.
        const dark = Boolean(((words[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
        matrix[y][x] = dark !== ((x + y) % 2 === 0);
        bit++;
      }
    }
  }
}

export function encodeOverlayCreditQr(): boolean[][] {
  const matrix = functionPatterns();
  placeWords(matrix, addParity(dataWords()));
  return matrix.map(row => row.map(module => module === true));
}
