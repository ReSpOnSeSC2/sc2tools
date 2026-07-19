// localTranslate — free, on-device chat translation for the overlay.
//
// Runs Helsinki-NLP's OPUS-MT many-to-English model
// (Xenova/opus-mt-mul-en, quantized ONNX) inside the OBS Browser
// Source via transformers.js (WASM). The model weights (~40-80 MB)
// download ONCE from the Hugging Face CDN on first use and are then
// served from the browser cache — no accounts, no API keys, no server
// traffic ever carries message text.
//
// Realtime discipline: a chat overlay must never fall behind, so
// translations are strictly serialized (concurrency 1), the wait
// queue is hard-capped (oldest dropped — a stale translation is
// worthless on stream), results are cached per text, and any failure
// (model fetch on an offline OBS machine, WASM init, inference)
// degrades silently to plain untranslated text.

/* ──────────────── shouldTranslate gate ──────────────── */

// Non-Latin scripts that clearly signal "not English": CJK ideographs,
// kana, Hangul, Cyrillic, Arabic, Hebrew, Thai, Devanagari, Greek,
// Georgian, Armenian. One codepoint class, used for ratio counting.
const NON_LATIN_LETTER = new RegExp(
  "[" +
    "Ͱ-Ͽ" + // Greek
    "Ѐ-ӿԀ-ԯ" + // Cyrillic + supplement
    "԰-֏" + // Armenian
    "֐-׿" + // Hebrew
    "؀-ۿݐ-ݿ" + // Arabic + supplement
    "ऀ-ॿ" + // Devanagari
    "฀-๿" + // Thai
    "Ⴀ-ჿ" + // Georgian
    "ᄀ-ᇿ" + // Hangul jamo
    "぀-ゟ゠-ヿ" + // Hiragana + Katakana
    "㐀-䶿一-鿿" + // CJK ideographs (ext A + base)
    "가-힯" + // Hangul syllables
    "豈-﫿" + // CJK compatibility ideographs
    "]",
);

// Latin letters beyond ASCII (diacritics / extended Latin) — a strong
// hint of a non-English Latin-script language (é, ñ, ü, ł, ş …).
const EXTENDED_LATIN_LETTER = new RegExp(
  "[À-ɏḀ-ỿ]",
);

const ASCII_LETTER = /[a-z]/i;

// ~40 of the most common English words. One whole-word hit marks the
// line as English. Deliberately tiny — this is a chat overlay gate,
// not a language identifier.
const ENGLISH_STOPWORDS = new Set([
  "the", "be", "is", "are", "was", "to", "of", "and", "a", "an", "in",
  "that", "have", "has", "it", "for", "not", "on", "with", "he", "she",
  "as", "you", "do", "at", "this", "but", "his", "her", "by", "from",
  "they", "we", "say", "what", "so", "if", "who", "get", "go", "me",
  "my", "your", "just", "lol", "gg",
]);

const URL_TOKEN = /(?:https?:\/\/|www\.)\S+/gi;
const EMOTE_TOKEN = /:[a-z0-9_]+:/gi;

/**
 * Pure gate deciding whether a chat line is worth sending through the
 * on-device model. False for empty/near-empty text, `!commands`,
 * URL-only and emote-token-only lines, and text that is confidently
 * already English.
 *
 * English detection is a deliberate lightweight heuristic (no language
 * detection dependency): if ≥30% of letters are non-Latin script →
 * translate; extended-Latin letters (diacritics) → translate; pure
 * ASCII text is treated as English when it contains a common English
 * word OR is >90% plain ASCII letters. Tradeoff: Latin-script
 * non-English WITHOUT diacritics or English-word overlap ("jajaja si
 * claro") may slip through untranslated — acceptable for a chat
 * overlay, where a false skip just shows the original line.
 */
export function shouldTranslate(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  if (trimmed.startsWith("!")) return false; // chat commands (!mmr …)

  // Strip URLs and :emote: runs — judge only what a viewer reads.
  const stripped = trimmed
    .replace(URL_TOKEN, " ")
    .replace(EMOTE_TOKEN, " ")
    .trim();
  if (!stripped) return false; // URL-only / emote-only

  let latinAscii = 0;
  let latinExtended = 0;
  let nonLatin = 0;
  for (const ch of stripped) {
    if (ASCII_LETTER.test(ch)) latinAscii += 1;
    else if (EXTENDED_LATIN_LETTER.test(ch)) latinExtended += 1;
    else if (NON_LATIN_LETTER.test(ch)) nonLatin += 1;
  }
  const letters = latinAscii + latinExtended + nonLatin;
  if (letters === 0) return false; // digits/punctuation only

  if (nonLatin / letters >= 0.3) return true;

  const words = stripped.toLowerCase().split(/[^a-z']+/);
  if (words.some((w) => ENGLISH_STOPWORDS.has(w))) return false;
  if (latinAscii / letters > 0.9 && latinExtended === 0) return false;

  // Latin text with diacritics and no common-English-word overlap —
  // most likely another language.
  return true;
}

/* ──────────────── on-device translator ──────────────── */

export type LocalTranslatorStatus = "idle" | "loading" | "ready" | "error";

export interface LocalTranslator {
  /** Resolves the translation, or null (skip: dropped/identical/error). */
  translate(text: string): Promise<string | null>;
  status(): LocalTranslatorStatus;
  close(): void;
}

/** Raw model call: text in → translated text out. */
type TranslateFn = (text: string) => Promise<string>;

export interface LocalTranslatorOptions {
  /**
   * Test seam — production uses the real transformers.js dynamic
   * import (loadTransformersPipeline below).
   */
  pipelineFactory?: () => Promise<TranslateFn>;
}

/** Oldest queued line is dropped beyond this — stay realtime. */
const QUEUE_CAP = 4;
/** Per-text result cache cap (Map iteration order = insertion order). */
const CACHE_CAP = 500;

const MODEL_ID = "Xenova/opus-mt-mul-en";

/**
 * Default pipeline factory: dynamic import keeps transformers.js (and
 * its WASM/ONNX machinery) entirely out of the SSR bundle and out of
 * the client bundle until the first local translation is requested.
 */
async function loadTransformersPipeline(): Promise<TranslateFn> {
  const { pipeline, env } = await import("@xenova/transformers");
  // Browser Source context: always fetch from the Hugging Face CDN
  // (browser-cached after the first download), never from local paths.
  env.allowLocalModels = false;
  const translator = await pipeline("translation", MODEL_ID, {
    quantized: true,
  });
  return async (text: string) => {
    const out = (await translator(text)) as
      | Array<{ translation_text?: string }>
      | { translation_text?: string };
    const first = Array.isArray(out) ? out[0] : out;
    return String(first?.translation_text ?? "");
  };
}

export function createLocalTranslator(
  options: LocalTranslatorOptions = {},
): LocalTranslator {
  const factory = options.pipelineFactory ?? loadTransformersPipeline;

  let status: LocalTranslatorStatus = "idle";
  let closed = false;
  let pipelinePromise: Promise<TranslateFn> | null = null;
  const cache = new Map<string, string | null>();
  /** WAITING jobs only — the in-flight job is removed before it runs. */
  const queue: Array<{
    text: string;
    resolve: (value: string | null) => void;
  }> = [];
  let pumping = false;

  const cacheSet = (text: string, value: string | null) => {
    if (cache.size >= CACHE_CAP) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(text, value);
  };

  const fail = () => {
    status = "error";
    pipelinePromise = null;
    // Flush waiters — plain text is the graceful outcome.
    while (queue.length > 0) queue.shift()!.resolve(null);
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0 && !closed && status !== "error") {
        // Take the job SYNCHRONOUSLY — the in-flight line must never
        // be a drop-oldest candidate while the model loads/runs.
        const job = queue.shift()!;
        // Lazy model load on the FIRST translation only.
        if (!pipelinePromise) {
          status = "loading";
          pipelinePromise = factory();
        }
        let run: TranslateFn;
        try {
          run = await pipelinePromise;
          status = "ready";
        } catch {
          // Model fetch failed (offline OBS box, CDN down) → degrade.
          job.resolve(null);
          fail();
          return;
        }
        if (closed) {
          job.resolve(null);
          return;
        }
        try {
          const raw = (await run(job.text)).trim();
          const cleaned =
            raw && raw.toLowerCase() !== job.text.trim().toLowerCase()
              ? raw
              : null;
          cacheSet(job.text, cleaned);
          job.resolve(cleaned);
        } catch {
          // Inference error — stop translating, stay realtime.
          job.resolve(null);
          fail();
          return;
        }
      }
    } finally {
      pumping = false;
    }
  };

  return {
    translate(text: string): Promise<string | null> {
      if (closed || status === "error") return Promise.resolve(null);
      const cached = cache.get(text);
      if (cached !== undefined) return Promise.resolve(cached);
      return new Promise<string | null>((resolve) => {
        queue.push({ text, resolve });
        // Hard cap: drop the OLDEST waiting line — on a live overlay a
        // translation that arrives late is worse than none.
        while (queue.length > QUEUE_CAP) {
          queue.shift()!.resolve(null);
        }
        void pump();
      });
    },
    status: () => status,
    close() {
      closed = true;
      while (queue.length > 0) queue.shift()!.resolve(null);
      cache.clear();
    },
  };
}

/* ──────────────── shared singleton ──────────────── */

let shared: LocalTranslator | null = null;

/**
 * Widget remounts (OBS scene switches, config identity changes) must
 * not re-download or re-initialise the model — the pipeline lives for
 * the page. Never closed on purpose.
 */
export function getSharedLocalTranslator(): LocalTranslator {
  if (!shared) shared = createLocalTranslator();
  return shared;
}

/** Test-only: drop the singleton so suites get a fresh instance. */
export function resetSharedLocalTranslatorForTests(): void {
  shared = null;
}
