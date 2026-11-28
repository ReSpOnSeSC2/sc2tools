/**
 * The opening-unit reveal's frame height. Every reveal style fills it, and
 * `RandomizerSequence` holds the same height while the reveal's code loads,
 * so the frame never grows when it arrives. Kept apart from the reveals so
 * the overlay's first load carries this number, not their code.
 */
export const UNIT_STAGE_HEIGHT = 370;
