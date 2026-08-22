/**
 * User-facing product counts used by marketing surfaces.
 *
 * Keep these values explicit so the landing page stays lightweight. The
 * matching test compares them with the real registries and catches drift.
 */
export const PRODUCT_FACTS = {
  overlayWidgets: 30,
  arcadeModes: 18,
  virtualSets: 7,
  chatPlatforms: 4,
  fingerprintArchetypes: 175,
  knownBuilds: 100,
} as const;
