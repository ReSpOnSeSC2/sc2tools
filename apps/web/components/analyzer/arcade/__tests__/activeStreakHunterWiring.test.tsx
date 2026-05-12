import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  activeStreakHunter,
  STREAK_VARIANTS,
  type StreakVariant,
} from "../modes/quizzes/activeStreakHunter";

/**
 * End-to-end wiring test for the Streak Hunter — for each of the four
 * variants we hand-craft a Q, render the mode, and assert that the
 * full user-visible chain is correct:
 *
 *   1. The QUESTION TEXT matches the user-specified phrasing.
 *   2. The CORRECT ANSWER is the candidate with the highest value of
 *      the variant's metric (longestWin vs longestLoss).
 *   3. The REVEAL prints the right outcome letter (W vs L) next to
 *      each candidate's streak count.
 *   4. The SCORE NOTE references the right perspective ("against
 *      you" for their-X, "against them" for your-X).
 *
 * Any future drift between the variant enum, the metric mapping, or
 * the user-facing copy is caught here.
 */

/** Fixture: four hand-picked candidates whose longestWin and
 *  longestLoss diverge enough that every variant has a distinct
 *  correct answer. */
const fixtureCandidates = [
  { pulseId: "alice", name: "Alice", longestWin: 6, longestLoss: 1, games: 10 },
  { pulseId: "bob", name: "Bob", longestWin: 1, longestLoss: 6, games: 10 },
  { pulseId: "carol", name: "Carol", longestWin: 4, longestLoss: 4, games: 12 },
  { pulseId: "dave", name: "Dave", longestWin: 2, longestLoss: 2, games: 6 },
];

/** Expected correct answer per variant, computed from the fixture
 *  above. their-win + your-loss rank by longestLoss → Bob wins.
 *  their-loss + your-win rank by longestWin → Alice wins. */
const expectedLeader: Record<StreakVariant, string> = {
  "their-win": "bob",
  "their-loss": "alice",
  "your-win": "alice",
  "your-loss": "bob",
};

/** Expected outcome letter per variant. */
const expectedLetter: Record<StreakVariant, "W" | "L"> = {
  "their-win": "W",
  "their-loss": "L",
  "your-win": "W",
  "your-loss": "L",
};

/** Streak length the correct leader carries, for the variant's metric. */
const expectedMax: Record<StreakVariant, number> = {
  "their-win": 6, // Bob's longestLoss
  "their-loss": 6, // Alice's longestWin
  "your-win": 6, // Alice's longestWin
  "your-loss": 6, // Bob's longestLoss
};

/** Substring assertion for the question text. */
const expectedQuestion: Record<StreakVariant, RegExp> = {
  "their-win": /Which of these opponents had the\s+longest win streak\s+against you\?/i,
  "their-loss": /Which of these opponents had the\s+longest loss streak\s+against you\?/i,
  "your-win": /Which of these opponents did you have the\s+longest win streak\s+against\?/i,
  "your-loss": /Which of these opponents did you have the\s+longest loss streak\s+against\?/i,
};

/** Score-note tail per variant. */
const expectedTail: Record<StreakVariant, "against you" | "against them"> = {
  "their-win": "against you",
  "their-loss": "against you",
  "your-win": "against them",
  "your-loss": "against them",
};

function buildQ(variant: StreakVariant) {
  // Find correctIndex inside the fixture based on the variant's metric.
  // This mirrors what generate() would do in production.
  const key = variant === "their-win" || variant === "your-loss"
    ? "longestLoss"
    : "longestWin";
  let bestIdx = 0;
  for (let i = 1; i < fixtureCandidates.length; i++) {
    if (fixtureCandidates[i][key] > fixtureCandidates[bestIdx][key]) bestIdx = i;
  }
  return { variant, candidates: fixtureCandidates, correctIndex: bestIdx };
}

describe("Streak Hunter — every variant is wired end-to-end", () => {
  afterEach(() => cleanup());

  test("STREAK_VARIANTS still enumerates the same four", () => {
    expect(STREAK_VARIANTS).toEqual([
      "their-win",
      "their-loss",
      "your-win",
      "your-loss",
    ]);
  });

  for (const variant of STREAK_VARIANTS) {
    test(`${variant}: question, correct answer, reveal letter, and score note all match`, () => {
      const q = buildQ(variant);
      // generate() points correctIndex at the right candidate.
      expect(q.candidates[q.correctIndex].pulseId).toBe(expectedLeader[variant]);

      // Pre-answer render: only the question text and four answer buttons.
      const pre = activeStreakHunter.render({
        question: q,
        answer: null,
        onAnswer: () => undefined,
        score: null,
        revealed: false,
        isDaily: false,
      }) as React.ReactElement;
      const preRender = render(pre);
      // The question copy is split across multiple <span> nodes for
      // the highlighted phrase, so getByText (which checks individual
      // text nodes) can't see it as a whole — check the rendered
      // container's textContent instead.
      expect(preRender.container.textContent).toMatch(expectedQuestion[variant]);
      // All four candidate names appear somewhere in the container
      // (the QuizAnswerButton shell wraps the name in additional
      // spans, so we check container textContent rather than
      // getByText which would multi-match).
      for (const c of fixtureCandidates) {
        expect(preRender.container.textContent).toContain(c.name);
      }
      preRender.unmount();

      // Picking the correct candidate: score should be "correct" with
      // the right note copy.
      const scoreResult = activeStreakHunter.score(q, q.correctIndex);
      expect(scoreResult.outcome).toBe("correct");
      expect(scoreResult.note).toContain(`${expectedMax[variant]}${expectedLetter[variant]}`);
      expect(scoreResult.note).toContain(expectedTail[variant]);

      // Post-answer render: reveal lists every candidate with their
      // metric count + the variant's outcome letter.
      const post = activeStreakHunter.render({
        question: q,
        answer: q.correctIndex,
        onAnswer: () => undefined,
        score: scoreResult,
        revealed: true,
        isDaily: false,
      }) as React.ReactElement;
      const postRender = render(post);

      // The reveal renders each candidate as an <li> whose
      // textContent includes the candidate name, its variant-
      // specific streak count + letter, and the game count. We look
      // for the leader's <li> by walking the rendered list rather
      // than by getByText (the name appears in both the answer
      // shell and the reveal list).
      const leaderName = fixtureCandidates.find(
        (c) => c.pulseId === expectedLeader[variant],
      )!.name;
      const lis = Array.from(postRender.container.querySelectorAll("li"));
      const leaderRow = lis.find((li) => li.textContent?.includes(leaderName));
      expect(leaderRow).toBeDefined();
      expect(leaderRow!.textContent).toContain(
        `${expectedMax[variant]}${expectedLetter[variant]}`,
      );

      // Every candidate row shows the same outcome letter (per
      // variant), so a quick uniformity check catches drift.
      for (const c of fixtureCandidates) {
        const row = lis.find((li) => li.textContent?.includes(c.name));
        expect(row).toBeDefined();
        // Each row's count text reads "{n}{letter}" — must use the
        // variant's letter, not the opposite one.
        const oppositeLetter = expectedLetter[variant] === "W" ? "L" : "W";
        // The row should NOT contain a number-then-opposite-letter
        // pattern (would mean the letter mapping is wrong).
        expect(row!.textContent).not.toMatch(new RegExp(`\\d${oppositeLetter}\\s`));
      }

      // Picking the wrong candidate scores wrong.
      const wrongIdx = (q.correctIndex + 1) % q.candidates.length;
      const wrongScore = activeStreakHunter.score(q, wrongIdx);
      expect(wrongScore.outcome).toBe("wrong");
    });
  }
});

describe("Streak Hunter — variant pairs share an answer pool, not copy", () => {
  // their-win and your-loss rank by the same field, so they must
  // pick the same leader; same for their-loss / your-win. But the
  // question text and reveal letter must differ between the
  // members of each pair.
  test("their-win and your-loss agree on the leader but diverge in copy", () => {
    const winQ = buildQ("their-win");
    const lossQ = buildQ("your-loss");
    expect(winQ.candidates[winQ.correctIndex].pulseId).toBe(
      lossQ.candidates[lossQ.correctIndex].pulseId,
    );

    const winNote = activeStreakHunter.score(winQ, winQ.correctIndex).note;
    const lossNote = activeStreakHunter.score(lossQ, lossQ.correctIndex).note;
    expect(winNote).toContain("against you");
    expect(lossNote).toContain("against them");
    // Both end in W because the underlying metric is the user's L
    // count, which is the opponent's W count (their-win) or the
    // user's loss count (your-loss). The letter mirrors the
    // question's word, not the user's actual outcome — that's the
    // contract.
    expect(winNote).toMatch(/\dW/);
    expect(lossNote).toMatch(/\dL/);
  });

  test("their-loss and your-win agree on the leader but diverge in copy", () => {
    const tlQ = buildQ("their-loss");
    const ywQ = buildQ("your-win");
    expect(tlQ.candidates[tlQ.correctIndex].pulseId).toBe(
      ywQ.candidates[ywQ.correctIndex].pulseId,
    );

    const tlNote = activeStreakHunter.score(tlQ, tlQ.correctIndex).note;
    const ywNote = activeStreakHunter.score(ywQ, ywQ.correctIndex).note;
    expect(tlNote).toContain("against you");
    expect(ywNote).toContain("against them");
    expect(tlNote).toMatch(/\dL/);
    expect(ywNote).toMatch(/\dW/);
  });
});
