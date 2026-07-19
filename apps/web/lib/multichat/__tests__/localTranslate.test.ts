// localTranslate — the free on-device translation engine. The gate
// (shouldTranslate) is pure and exhaustively tabled; the translator's
// queue/cache/error behavior runs against an injected fake pipeline
// factory so no model, WASM or network is ever involved.

import { describe, expect, test } from "vitest";
import {
  createLocalTranslator,
  shouldTranslate,
} from "@/lib/multichat/localTranslate";

/* ──────────────── shouldTranslate ──────────────── */

describe("shouldTranslate", () => {
  test.each([
    ["こんにちは、元気ですか", true], // Japanese
    ["你好主播", true], // Chinese
    ["привет как дела", true], // Russian (Cyrillic)
    ["مرحبا كيف حالك", true], // Arabic
    ["안녕하세요", true], // Korean (Hangul)
    ["สวัสดีครับ", true], // Thai
    ["γεια σου φίλε", true], // Greek
  ])("non-Latin script %s → translate", (text, expected) => {
    expect(shouldTranslate(text)).toBe(expected);
  });

  test.each([
    ["hello everyone, how is the stream going?", false],
    ["that was a great game", false],
    ["you should build more marines", false],
    ["GG WP", false], // common chat English ("gg")
  ])("English sentence %s → skip", (text, expected) => {
    expect(shouldTranslate(text)).toBe(expected);
  });

  test("Latin text with diacritics and no English-word overlap → translate", () => {
    expect(shouldTranslate("qué partidazo, increíble jugada")).toBe(true);
  });

  test("documented tradeoff: plain-ASCII non-English may skip", () => {
    // Latin-script, no diacritics, no common-English-word overlap —
    // treated as English and skipped (acceptable for a chat overlay).
    expect(shouldTranslate("jajaja si claro")).toBe(false);
  });

  test("mixed CJK + Latin (≥30% non-Latin letters) → translate", () => {
    expect(shouldTranslate("gg 今日の試合は最高でした")).toBe(true);
  });

  test.each([
    ["", false],
    ["   ", false],
    ["a", false], // shorter than 2 chars
    ["!mmr", false], // chat command
    ["!построить", false], // command in any language
    [":kekw: :fire:", false], // emote tokens only
    ["https://example.com/clip", false], // URL only
    ["www.example.com https://twitch.tv/x", false],
    ["12345 !!!", false], // no letters at all
  ])("noise %j → skip", (text, expected) => {
    expect(shouldTranslate(text)).toBe(expected);
  });

  test("URL/emote noise around real foreign text still translates", () => {
    expect(shouldTranslate(":kekw: 今日はありがとう https://a.io/x")).toBe(true);
  });
});

/* ──────────────── translator queue/cache/errors ──────────────── */

/** Fake pipeline whose per-call completion the test controls. */
function makeManualPipeline() {
  const calls: string[] = [];
  const waiters: Array<(value: string) => void> = [];
  const run = (text: string) => {
    calls.push(text);
    return new Promise<string>((resolve) => {
      waiters.push(resolve);
    });
  };
  return {
    calls,
    factoryCalls: 0,
    resolveNext(value: string) {
      const w = waiters.shift();
      if (!w) throw new Error("no pending pipeline call");
      w(value);
    },
    factory() {
      this.factoryCalls += 1;
      return Promise.resolve(run);
    },
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createLocalTranslator", () => {
  test("lazy load on first translate, then serialized concurrency 1", async () => {
    const fake = makeManualPipeline();
    const t = createLocalTranslator({ pipelineFactory: () => fake.factory() });
    expect(t.status()).toBe("idle");

    const p1 = t.translate("hola uno");
    const p2 = t.translate("hola dos");
    await tick();
    expect(fake.factoryCalls).toBe(1);
    expect(t.status()).toBe("ready");
    // Strictly one in flight — the second waits for the first.
    expect(fake.calls).toEqual(["hola uno"]);

    fake.resolveNext("hello one");
    await expect(p1).resolves.toBe("hello one");
    await tick();
    expect(fake.calls).toEqual(["hola uno", "hola dos"]);
    fake.resolveNext("hello two");
    await expect(p2).resolves.toBe("hello two");
  });

  test("caches repeated texts (single pipeline call)", async () => {
    const fake = makeManualPipeline();
    const t = createLocalTranslator({ pipelineFactory: () => fake.factory() });
    const p1 = t.translate("bonjour");
    await tick();
    fake.resolveNext("hello");
    await expect(p1).resolves.toBe("hello");
    await expect(t.translate("bonjour")).resolves.toBe("hello");
    expect(fake.calls).toEqual(["bonjour"]);
  });

  test("drops the OLDEST waiting line beyond the queue cap", async () => {
    const fake = makeManualPipeline();
    const t = createLocalTranslator({ pipelineFactory: () => fake.factory() });
    const results: Array<string | null> = [];
    const promises = Array.from({ length: 7 }, (_, i) =>
      t.translate(`line ${i}`).then((v) => {
        results[i] = v;
        return v;
      }),
    );
    await tick();
    // line 0 is running; cap 4 keeps the NEWEST 4 waiters (3,4,5,6) —
    // 1 and 2 were dropped immediately as null.
    expect(fake.calls).toEqual(["line 0"]);
    await expect(promises[1]).resolves.toBeNull();
    await expect(promises[2]).resolves.toBeNull();

    fake.resolveNext("out 0");
    await tick();
    fake.resolveNext("out 3");
    await tick();
    fake.resolveNext("out 4");
    await tick();
    fake.resolveNext("out 5");
    await tick();
    fake.resolveNext("out 6");
    await Promise.all(promises);
    expect(results).toEqual([
      "out 0",
      null,
      null,
      "out 3",
      "out 4",
      "out 5",
      "out 6",
    ]);
  });

  test("output identical to input (case-insensitive) → null, and cached", async () => {
    const fake = makeManualPipeline();
    const t = createLocalTranslator({ pipelineFactory: () => fake.factory() });
    const p = t.translate("GG WP");
    await tick();
    fake.resolveNext("gg wp");
    await expect(p).resolves.toBeNull();
    // Cached null — no second pipeline call.
    await expect(t.translate("GG WP")).resolves.toBeNull();
    expect(fake.calls).toEqual(["GG WP"]);
  });

  test("empty model output → null", async () => {
    const fake = makeManualPipeline();
    const t = createLocalTranslator({ pipelineFactory: () => fake.factory() });
    const p = t.translate("???? text");
    await tick();
    fake.resolveNext("   ");
    await expect(p).resolves.toBeNull();
  });

  test("factory failure (offline model download) degrades silently", async () => {
    let factoryCalls = 0;
    const t = createLocalTranslator({
      pipelineFactory: () => {
        factoryCalls += 1;
        return Promise.reject(new Error("fetch failed"));
      },
    });
    await expect(t.translate("привет")).resolves.toBeNull();
    expect(t.status()).toBe("error");
    // Further calls are cheap no-ops — the factory is not retried.
    await expect(t.translate("привет опять")).resolves.toBeNull();
    expect(factoryCalls).toBe(1);
  });

  test("inference error mid-stream flushes waiters and errors out", async () => {
    let reject: ((err: Error) => void) | null = null;
    const t = createLocalTranslator({
      pipelineFactory: () =>
        Promise.resolve(
          () =>
            new Promise<string>((_res, rej) => {
              reject = rej;
            }),
        ),
    });
    const p1 = t.translate("uno");
    const p2 = t.translate("dos");
    await tick();
    reject!(new Error("wasm crashed"));
    await expect(p1).resolves.toBeNull();
    await expect(p2).resolves.toBeNull();
    expect(t.status()).toBe("error");
  });

  test("close() flushes waiters as null and refuses new work", async () => {
    const fake = makeManualPipeline();
    const t = createLocalTranslator({ pipelineFactory: () => fake.factory() });
    const p = t.translate("hola");
    t.close();
    await expect(p).resolves.toBeNull();
    await expect(t.translate("otra")).resolves.toBeNull();
  });
});

describe("warmUp", () => {
  test("starts the model load once, before any translation", async () => {
    let factoryCalls = 0;
    const { createLocalTranslator } = await import("@/lib/multichat/localTranslate");
    const translator = createLocalTranslator({
      pipelineFactory: async () => {
        factoryCalls += 1;
        return async (text: string) => `T:${text}`;
      },
    });
    expect(translator.status()).toBe("idle");
    translator.warmUp();
    expect(translator.status()).toBe("loading");
    translator.warmUp(); // idempotent
    await Promise.resolve();
    await Promise.resolve();
    expect(factoryCalls).toBe(1);
    expect(translator.status()).toBe("ready");
    // A translation after warm-up reuses the same pipeline.
    await expect(translator.translate("привет")).resolves.toBe("T:привет");
    expect(factoryCalls).toBe(1);
    translator.close();
  });

  test("a failed warm-up degrades to error without throwing", async () => {
    const { createLocalTranslator } = await import("@/lib/multichat/localTranslate");
    const translator = createLocalTranslator({
      pipelineFactory: async () => {
        throw new Error("cdn down");
      },
    });
    translator.warmUp();
    await Promise.resolve();
    await Promise.resolve();
    expect(translator.status()).toBe("error");
    await expect(translator.translate("привет")).resolves.toBeNull();
    translator.close();
  });
});
