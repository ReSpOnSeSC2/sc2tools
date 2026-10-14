"use strict";

const BUILD_PROFILE_AXIS_KEYS = Object.freeze([
  "aggressiveness",
  "defensiveness",
  "executionDifficulty",
  "popularity",
  "micro",
]);
const BUILD_PROFILE_TITLE_MAX = 80;
const BUILD_PROFILE_LABEL_MAX = 32;
const DEFAULT_BUILD_PROFILE_LABELS = Object.freeze({
  aggressiveness: "Aggressiveness",
  defensiveness: "Defensiveness",
  executionDifficulty: "Execution difficulty",
  popularity: "Build popularity",
  micro: "Micro required",
});
const DEFAULT_BUILD_PROFILE = Object.freeze({
  title: "",
  labels: DEFAULT_BUILD_PROFILE_LABELS,
  ratings: Object.freeze({
    aggressiveness: null,
    defensiveness: null,
    executionDifficulty: null,
    popularity: null,
    micro: null,
  }),
  visible: false,
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is number} */
function isRating(value) {
  return typeof value === "number" && Number.isInteger(value)
    && value >= 1 && value <= 5;
}

/**
 * Read legacy or malformed documents safely. Unknown/missing ratings stay
 * unset; an incomplete profile can never draw an invented shape on stream.
 *
 * @param {unknown} raw
 * @returns {{title: string, labels: Record<string, string>, ratings: Record<string, number | null>, visible: boolean}}
 */
function sanitizeBuildProfile(raw) {
  const profile = isRecord(raw) ? raw : {};
  const incomingRatings = isRecord(profile.ratings) ? profile.ratings : {};
  const incomingLabels = isRecord(profile.labels) ? profile.labels : {};
  /** @type {Record<string, number | null>} */
  const ratings = {};
  /** @type {Record<string, string>} */
  const labels = {};
  for (const key of BUILD_PROFILE_AXIS_KEYS) {
    const value = incomingRatings[key];
    ratings[key] = isRating(value) ? value : null;
    const label = incomingLabels[key];
    const trimmed = typeof label === "string" ? label.trim() : "";
    labels[key] = trimmed && trimmed.length <= BUILD_PROFILE_LABEL_MAX
      ? trimmed : DEFAULT_BUILD_PROFILE_LABELS[/** @type {keyof typeof DEFAULT_BUILD_PROFILE_LABELS} */ (key)];
  }
  const title = typeof profile.title === "string"
    ? profile.title.trim().slice(0, BUILD_PROFILE_TITLE_MAX) : "";
  const complete = title.length > 0
    && BUILD_PROFILE_AXIS_KEYS.every((key) => ratings[key] !== null);
  return { title, labels, ratings, visible: profile.visible === true && complete };
}

/** @param {string} message @param {string} [code] */
function profileError(message, code = "invalid_build_profile") {
  return Object.assign(new Error(message), { status: 400, code });
}

/**
 * Merge a nested partial edit into the last persisted snapshot. Visibility
 * changes keep the selected build/ratings; score edits keep visibility.
 * Unlike read sanitization, writes reject malformed or coerced scores.
 *
 * @param {unknown} patch
 * @param {unknown} previous
 */
function prepareBuildProfileUpdate(patch, previous) {
  if (!isRecord(patch)) throw profileError("Build profile must be an object.");
  const next = sanitizeBuildProfile(previous);
  if (Object.hasOwn(patch, "title")) {
    if (typeof patch.title !== "string") {
      throw profileError("Build name must be text.");
    }
    next.title = patch.title.trim().slice(0, BUILD_PROFILE_TITLE_MAX);
  }
  if (Object.hasOwn(patch, "ratings")) {
    if (!isRecord(patch.ratings)) {
      throw profileError("Build ratings must be an object.");
    }
    for (const key of BUILD_PROFILE_AXIS_KEYS) {
      if (!Object.hasOwn(patch.ratings, key)) continue;
      const value = patch.ratings[key];
      if (value !== null && !isRating(value)) {
        throw profileError("Each build rating must be an integer from 1 to 5, or unset.");
      }
      next.ratings[key] = value;
    }
  }
  if (Object.hasOwn(patch, "labels")) {
    if (!isRecord(patch.labels)) {
      throw profileError("Build axis labels must be an object.");
    }
    for (const key of BUILD_PROFILE_AXIS_KEYS) {
      if (!Object.hasOwn(patch.labels, key)) continue;
      const value = patch.labels[key];
      const label = typeof value === "string" ? value.trim() : "";
      if (!label || label.length > BUILD_PROFILE_LABEL_MAX) {
        throw profileError("Each axis label must be nonblank text of at most 32 characters.");
      }
      next.labels[key] = label;
    }
  }
  if (Object.hasOwn(patch, "visible")) {
    if (typeof patch.visible !== "boolean") {
      throw profileError("Build profile visibility must be true or false.");
    }
    next.visible = patch.visible;
  }
  if (next.visible && (!next.title
    || BUILD_PROFILE_AXIS_KEYS.some((key) => next.ratings[key] === null))) {
    throw profileError("Set a build name and all five ratings before showing the graph.",
      "incomplete_build_profile");
  }
  return next;
}

module.exports = {
  BUILD_PROFILE_AXIS_KEYS,
  DEFAULT_BUILD_PROFILE,
  DEFAULT_BUILD_PROFILE_LABELS,
  sanitizeBuildProfile,
  prepareBuildProfileUpdate,
};
