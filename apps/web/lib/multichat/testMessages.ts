// Shared scripted samples for both Test fires and the local playground.
import fixtures from "../overlaySamples.json";
import type { ChatMessage } from "./types";
const TEST_SEQUENCE = fixtures.demo.chat as Omit<ChatMessage, "id" | "atMs">[];
export function testChatMessage(index: number, atMs: number): ChatMessage | null {
  const seed = TEST_SEQUENCE[index];
  return seed ? { ...seed, badges: [...seed.badges], id: `test-${index}-${atMs}`, atMs } : null;
}
export const TEST_SEQUENCE_LENGTH = TEST_SEQUENCE.length;
export const TEST_MESSAGE_INTERVAL_MS = 850;
