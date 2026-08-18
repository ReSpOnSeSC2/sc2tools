/**
 * voiceCatalog — one honest answer to "which voices can this app
 * actually speak with, and what happens to the one I picked?"
 *
 * ## The problem this solves
 *
 * The streamer picks a voice in Settings, running in desktop Chrome.
 * The scouting readout then speaks from a *different* runtime — the OBS
 * / Streamlabs Browser Source, which is embedded Chromium (CEF). Those
 * two runtimes ship different voice inventories:
 *
 *   - Desktop **Chrome** exposes the "Google ..." voices. They are
 *     *network* voices synthesised by a Google backend that official
 *     Chrome builds are keyed for. ``localService`` is ``false``.
 *   - **Edge** additionally exposes "Microsoft ... Online (Natural)"
 *     voices — also network, also keyed to that browser.
 *   - **OBS / Streamlabs CEF** has no such keys. It sees only the
 *     local OS voices: SAPI on Windows ("Microsoft David/Zira/Mark"),
 *     the system voices on macOS ("Samantha", "Alex", ...).
 *
 * So "Google UK English Female" is genuinely *impossible* inside OBS.
 * Nothing in this codebase can conjure it. The previous behaviour
 * offered it in the dropdown anyway and then fell back to whatever the
 * engine called ``default`` — which on Windows is **Microsoft David, a
 * male voice**. The streamer picked a female voice and got a male one,
 * with no explanation. That is the bug.
 *
 * ## What we do about it
 *
 * 1. {@link classifyVoice} labels every voice ``portable`` (present in
 *    any runtime, including OBS) or ``chromeOnly`` (network voice that
 *    dies outside its own browser). Settings hides the latter by
 *    default, so the picker only offers voices that will really work.
 * 2. {@link inferVoiceGender} reads the gender out of the voice name.
 *    Persisted with the pick, so when a fallback IS needed we can hold
 *    the gender steady — a female pick degrades to Zira/Hazel, never to
 *    David.
 * 3. {@link resolveVoice} is the single fallback ladder every speech
 *    path in the app now shares, and it reports *why* it landed where
 *    it did so the UI can say so out loud.
 *
 * Pure functions over a plain ``SpeechSynthesisVoice[]`` — no DOM
 * access, so this unit-tests without a speech engine.
 */

/* ---------------- types ---------------- */

export type VoiceGender = "female" | "male" | "neutral";

/**
 * Where a voice can actually be spoken.
 *
 *   ``portable``   — a local OS voice. Present in Chrome, Edge, Firefox
 *                    and the OBS/Streamlabs Browser Source alike. Safe.
 *   ``chromeOnly`` — a network voice bound to the browser that ships the
 *                    API key (Google in Chrome, "Online (Natural)" in
 *                    Edge). Silently unavailable inside OBS.
 */
export type VoiceAvailability = "portable" | "chromeOnly";

export interface ClassifiedVoice {
  /** The engine's own voice object, for direct assignment to an utterance. */
  voice: SpeechSynthesisVoice;
  name: string;
  lang: string;
  gender: VoiceGender;
  availability: VoiceAvailability;
  /** Engine family, for grouping/labels: "Google" | "Microsoft" | "Apple" | "Other". */
  engine: string;
  /** True when this runtime reports the voice as its default. */
  isDefault: boolean;
}

/** What the streamer asked for, as persisted in their preferences. */
export interface VoiceWish {
  /** Voice NAME exactly as it appeared in the picker. */
  name?: string;
  /** BCP-47 lang captured alongside the pick (e.g. "en-GB"). */
  lang?: string;
  /** Gender captured alongside the pick, so fallbacks can preserve it. */
  gender?: VoiceGender;
}

/** Why {@link resolveVoice} returned what it returned. */
export type VoiceResolutionReason =
  /** The exact voice they picked is installed here. */
  | "exact"
  /** Same voice, trivially different label (case/spacing drift). */
  | "normalized"
  /** Not installed here; matched language AND gender. */
  | "genderMatch"
  /** Not installed here; matched language, gender unavailable. */
  | "langMatch"
  /** Nothing matched — the engine default will speak. */
  | "engineDefault"
  /** The engine has reported no voices at all (yet). */
  | "catalogEmpty"
  /** No preference set — the engine default is the correct answer. */
  | "noPreference";

export interface VoiceResolution {
  voice: SpeechSynthesisVoice | null;
  reason: VoiceResolutionReason;
  /** True when the chosen voice is not the one the streamer asked for. */
  substituted: boolean;
}

/* ---------------- gender inference ---------------- */

/**
 * Voices whose gender their NAME does not state. Keyed by lowercased
 * given name, because engines dress the same voice up differently
 * ("Zira", "Microsoft Zira Desktop - English (United States)").
 *
 * Covers the Windows SAPI set (the OBS-on-Windows reality, which is the
 * overwhelming majority of this app's users), the Edge natural voices,
 * and the macOS system voices.
 */
const GENDER_BY_NAME: Record<string, VoiceGender> = {
  // -- Windows SAPI / Microsoft desktop --
  zira: "female",
  hazel: "female",
  susan: "female",
  linda: "female",
  heera: "female",
  catherine: "female",
  eva: "female",
  david: "male",
  mark: "male",
  george: "male",
  james: "male",
  richard: "male",
  ravi: "male",
  sean: "male",
  // -- Microsoft "Online (Natural)" / Azure neural --
  aria: "female",
  jenny: "female",
  michelle: "female",
  ana: "female",
  sonia: "female",
  libby: "female",
  natasha: "female",
  clara: "female",
  neerja: "female",
  guy: "male",
  eric: "male",
  christopher: "male",
  roger: "male",
  steffan: "male",
  ryan: "male",
  thomas: "male",
  william: "male",
  liam: "male",
  prabhat: "male",
  // -- macOS / iOS system voices --
  samantha: "female",
  victoria: "female",
  allison: "female",
  ava: "female",
  karen: "female",
  moira: "female",
  tessa: "female",
  fiona: "female",
  kathy: "female",
  vicki: "female",
  serena: "female",
  nicky: "female",
  alex: "male",
  fred: "male",
  daniel: "male",
  tom: "male",
  rishi: "male",
  oliver: "male",
  aaron: "male",
  bruce: "male",
  ralph: "male",
};

/**
 * Determine a voice's gender from its name.
 *
 * Engines label this three different ways and we handle all of them:
 *   1. Explicitly — "Google UK English **Female**".
 *   2. By given name — "Microsoft **Zira** - English (United States)".
 *   3. Not at all — "Google espanol". Those come back ``neutral``,
 *      which the resolver treats as "gender is not a constraint" rather
 *      than as a third gender to match against.
 */
export function inferVoiceGender(name: string | undefined | null): VoiceGender {
  if (!name) return "neutral";
  const n = name.toLowerCase();

  // 1. The label says so outright. Checked first — it is authoritative
  //    and beats any given-name coincidence in the same string.
  if (/\bfemale\b|\bwoman\b/.test(n)) return "female";
  if (/\bmale\b|\bman\b/.test(n)) return "male";

  // 2. A known given name anywhere in the label. Word-boundary matched
  //    so "Mark" doesn't fire on "Denmark".
  for (const [key, gender] of Object.entries(GENDER_BY_NAME)) {
    if (new RegExp(`\\b${key}\\b`).test(n)) return gender;
  }

  // 3. Unknown — do not guess. "neutral" means "no constraint".
  return "neutral";
}

/* ---------------- availability classification ---------------- */

/**
 * Names that mark a *network* voice — one synthesised server-side by
 * the browser vendor, and therefore absent from the OBS/Streamlabs CEF
 * runtime no matter what the streamer installs on their machine.
 */
const NETWORK_VOICE_PATTERNS = [
  /^google\s/i,
  /\bonline\b/i,
  /\bnatural\b/i,
  /\bneural\b/i,
  /\bcloud\b/i,
];

/**
 * Can this voice be spoken outside the browser that listed it?
 *
 * ``localService`` is the primary signal and the standard-blessed one:
 * the spec defines it as "the synthesis is performed on the local
 * device". Every network voice reports ``false``. We *also* name-match,
 * because a handful of Chromium builds report ``localService: true``
 * for the Google voices even though they demonstrably are not local —
 * trusting that flag alone is what let these voices into the picker in
 * the first place.
 */
export function classifyAvailability(
  voice: Pick<SpeechSynthesisVoice, "name" | "localService">,
): VoiceAvailability {
  if (NETWORK_VOICE_PATTERNS.some((re) => re.test(voice.name))) {
    return "chromeOnly";
  }
  // Undefined localService (very old engines) is treated as local: the
  // name check above already caught the known network families, and
  // wrongly hiding a real local voice is worse than the reverse.
  if (voice.localService === false) return "chromeOnly";
  return "portable";
}

/** "Microsoft Zira - English (United States)" -> "Microsoft". */
export function voiceEngine(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith("google")) return "Google";
  if (n.startsWith("microsoft")) return "Microsoft";
  if (/^(com\.apple|apple)/.test(n)) return "Apple";
  return "Other";
}

export function classifyVoice(voice: SpeechSynthesisVoice): ClassifiedVoice {
  return {
    voice,
    name: voice.name,
    lang: voice.lang || "",
    gender: inferVoiceGender(voice.name),
    availability: classifyAvailability(voice),
    engine: voiceEngine(voice.name),
    isDefault: !!voice.default,
  };
}

export function classifyCatalog(
  voices: readonly SpeechSynthesisVoice[],
): ClassifiedVoice[] {
  return voices.map(classifyVoice);
}

/**
 * The voices worth offering in a picker: everything that will still
 * work when the overlay runs inside OBS. Chrome-only network voices are
 * excluded — they are the trap this whole module exists to close.
 */
export function usableVoices(
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice[] {
  return voices.filter((v) => classifyAvailability(v) === "portable");
}

/* ---------------- name / lang normalisation ---------------- */

export function normalizeVoiceName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeLang(lang: string | undefined | null): string {
  return (lang || "").trim().toLowerCase().replace(/_/g, "-");
}

/**
 * Best-effort language inference from a voice NAME, for preferences
 * saved before the lang was captured alongside the pick.
 */
export function inferLangFromVoiceName(
  name: string | undefined | null,
): string | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (/\ben-gb\b|uk english|british|english \(united kingdom\)|\(uk\)/.test(n)) {
    return "en-GB";
  }
  if (/\ben-us\b|us english|english \(united states\)|\(us\)/.test(n)) {
    return "en-US";
  }
  if (/\ben-au\b|australian|english \(australia\)/.test(n)) return "en-AU";
  if (/\ben-in\b|indian|english \(india\)/.test(n)) return "en-IN";
  if (/\ben-ca\b|english \(canada\)/.test(n)) return "en-CA";
  if (/\benglish\b|\ben-[a-z]{2}\b/.test(n)) return "en";
  return null;
}

/* ---------------- the resolver ---------------- */

/**
 * Rank candidates within a tier. Prefers a locally-synthesised voice
 * (it cannot cut out mid-sentence the way a network voice can), then
 * the engine default, then catalog order. Note the deliberate ordering
 * versus the old code, which put ``default`` first and so handed every
 * Windows fallback to Microsoft David.
 */
function bestOf(pool: ClassifiedVoice[]): SpeechSynthesisVoice | null {
  if (pool.length === 0) return null;
  const ranked =
    pool.find((v) => v.availability === "portable" && v.isDefault)
    ?? pool.find((v) => v.availability === "portable")
    ?? pool.find((v) => v.isDefault)
    ?? pool[0];
  return ranked.voice;
}

function langPool(
  catalog: ClassifiedVoice[],
  lang: string | null,
): ClassifiedVoice[] {
  const target = normalizeLang(lang);
  if (!target) return [];
  const base = target.split("-")[0];
  const exact = catalog.filter((v) => normalizeLang(v.lang) === target);
  if (exact.length > 0) return exact;
  return catalog.filter((v) => normalizeLang(v.lang).split("-")[0] === base);
}

/**
 * Resolve a saved voice preference against the catalog THIS runtime
 * actually exposes, degrading gracefully and reporting how far it fell.
 *
 * The ladder, in order:
 *
 *   1. **exact** — the picked voice is installed here. The happy path.
 *   2. **normalized** — same voice, label whitespace/case drift.
 *   3. **genderMatch** — the pick is missing (the OBS/CEF case), so take
 *      the closest voice in the same language *of the same gender*.
 *      This is the rung that stops a "Google UK English Female" pick
 *      from turning into Microsoft David.
 *   4. **langMatch** — same language, gender unavailable or unknown.
 *   5. **engineDefault** — nothing matched; leave the utterance alone
 *      and let the engine pick.
 */
export function resolveVoice(
  voices: readonly SpeechSynthesisVoice[],
  wish: VoiceWish | undefined,
): VoiceResolution {
  if (voices.length === 0) {
    return { voice: null, reason: "catalogEmpty", substituted: false };
  }
  const wantedName = wish?.name?.trim();
  const wantedLang = wish?.lang?.trim();
  const wantedGender = wish?.gender;
  if (!wantedName && !wantedLang) {
    return { voice: null, reason: "noPreference", substituted: false };
  }

  const catalog = classifyCatalog(voices);

  if (wantedName) {
    const exact = catalog.find((v) => v.name === wantedName);
    if (exact) {
      return { voice: exact.voice, reason: "exact", substituted: false };
    }
    const wanted = normalizeVoiceName(wantedName);
    const normalized = catalog.find(
      (v) => normalizeVoiceName(v.name) === wanted,
    );
    if (normalized) {
      return {
        voice: normalized.voice,
        reason: "normalized",
        substituted: false,
      };
    }
  }

  const lang = wantedLang || inferLangFromVoiceName(wantedName);
  const pool = langPool(catalog, lang);
  if (pool.length === 0) {
    return { voice: null, reason: "engineDefault", substituted: !!wantedName };
  }

  // Gender is only a constraint when we know it. "neutral" means the
  // name never stated one, so matching on it would be noise.
  const gender = wantedGender ?? inferVoiceGender(wantedName);
  if (gender === "female" || gender === "male") {
    const sameGender = pool.filter((v) => v.gender === gender);
    const picked = bestOf(sameGender);
    if (picked) {
      return { voice: picked, reason: "genderMatch", substituted: true };
    }
  }

  const picked = bestOf(pool);
  if (!picked) {
    return { voice: null, reason: "engineDefault", substituted: !!wantedName };
  }
  return { voice: picked, reason: "langMatch", substituted: true };
}

/* ---------------- UI helpers ---------------- */

const GENDER_LABEL: Record<VoiceGender, string> = {
  female: "female",
  male: "male",
  neutral: "",
};

/** "Microsoft Zira - English (United States)" -> "... - ... | female". */
export function describeVoice(voice: SpeechSynthesisVoice): string {
  const g = GENDER_LABEL[inferVoiceGender(voice.name)];
  return g ? `${voice.name} - ${g}` : voice.name;
}

/**
 * Plain-language explanation of a resolution, for the Settings preview
 * line. Returns null when there is nothing worth saying (the exact pick
 * is playing, which is the boring, correct case).
 */
export function explainResolution(
  resolution: VoiceResolution,
  wish: VoiceWish | undefined,
): string | null {
  const wanted = wish?.name;
  switch (resolution.reason) {
    case "exact":
    case "normalized":
    case "noPreference":
      return null;
    case "catalogEmpty":
      return "This browser hasn't reported any voices yet.";
    case "genderMatch":
      return resolution.voice
        ? `"${wanted}" isn't available here - speaking as ${resolution.voice.name} (closest ${inferVoiceGender(wanted)} voice in the same language).`
        : null;
    case "langMatch":
      return resolution.voice
        ? `"${wanted}" isn't available here - speaking as ${resolution.voice.name}.`
        : null;
    case "engineDefault":
      return `"${wanted}" isn't available here and nothing matches its language - the system default voice will speak.`;
    default:
      return null;
  }
}
