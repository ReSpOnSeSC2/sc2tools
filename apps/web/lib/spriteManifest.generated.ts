/* eslint-disable */
/**
 * GENERATED FILE — do not edit by hand.
 * Run `node scripts/gen-sprite-manifest.mjs` after re-rendering sprites.
 *
 * Baked geometry for the 127 Blender-rendered SC2 sprite sheets
 * (78 units, 49 buildings). Field meanings:
 *
 *   frameSize  px per grid cell in the SOURCE sheet
 *   facings    8 for units (row = facing), 1 for buildings (never rotate)
 *   cols/rows  grid derived from sheetSize / frameSize — the draw path
 *              addresses cell (facing * cols + frame), so this is the
 *              single source of truth for BOTH the 8x8 unit sheets and
 *              the 4x2 / 1x1 building sheets
 *   suffix     sheet filename suffix ("Walk" -> Name_color_Walk.webp),
 *              null for the default sheet (Name_color.webp)
 *   wupc       worldUnitsPerCell — how many SC2 world-X units one cell
 *              spans. Draw width in px = wupc * pixelsPerWorldUnit.
 *   ax, ay     anchor px inside the cell where the model's ground
 *              origin projects; this pixel lands on the map coordinate
 */

export interface SpriteAnimMeta {
  readonly frames: number;
  readonly fps: number;
  readonly cols: number;
  readonly rows: number;
  readonly suffix: string | null;
  readonly wupc: number;
  readonly ax: number;
  readonly ay: number;
}

export interface SpriteSheetMeta {
  readonly kind: "unit" | "building";
  readonly race: "Terran" | "Protoss" | "Zerg";
  readonly frameSize: number;
  readonly facings: number;
  readonly anims: Readonly<Record<string, SpriteAnimMeta>>;
}

export const SPRITE_MANIFEST: Readonly<Record<string, SpriteSheetMeta>> = {
  "Adept": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 8, rows: 8, suffix: null, wupc: 1.7, ax: 128, ay: 170.4 },
      Walk: { frames: 8, fps: 12, cols: 8, rows: 8, suffix: "Walk", wupc: 1.7, ax: 128, ay: 163.4 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 2.85, ax: 128, ay: 152.9248 },
    },
  },
  "Archon": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4.36, cols: 8, rows: 8, suffix: null, wupc: 2.85, ax: 128, ay: 210.6 },
      Walk: { frames: 8, fps: 6.32, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 189 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 4.8, ax: 128, ay: 189.5816 },
    },
  },
  "Armory": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 0.8, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 265.5, ay: 286.2 },
    },
  },
  "Assimilator": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 4.8, ax: 255.1, ay: 315.6 },
    },
  },
  "AutoTurret": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 2.2, ax: 128, ay: 151.7 },
    },
  },
  "Baneling": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 5.33, cols: 8, rows: 8, suffix: null, wupc: 1.7, ax: 128, ay: 145.6 },
      Walk: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Walk", wupc: 2.2, ax: 128, ay: 135.8 },
    },
  },
  "BanelingCocoon": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 1.7, ax: 128.1, ay: 157.5 },
    },
  },
  "BanelingNest": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 0.6, cols: 4, rows: 2, suffix: null, wupc: 6.25, ax: 250.2, ay: 328.6 },
    },
  },
  "Banshee": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 5.33, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 130.6 },
      Walk: { frames: 8, fps: 5.33, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 137.7 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 3.7, ax: 128, ay: 130.0416 },
    },
  },
  "Barracks": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 6.25, ax: 256, ay: 306.3 },
    },
  },
  "Battlecruiser": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 8, rows: 8, suffix: null, wupc: 6.25, ax: 128, ay: 122.8 },
      Walk: { frames: 8, fps: 2.4, cols: 8, rows: 8, suffix: "Walk", wupc: 6.25, ax: 128, ay: 122.8 },
    },
  },
  "BroodLord": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 4.8, ax: 128, ay: 125.5 },
      Walk: { frames: 8, fps: 7.06, cols: 8, rows: 8, suffix: "Walk", wupc: 4.8, ax: 128, ay: 124.6 },
    },
  },
  "BroodLordCocoon": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.6, cols: 4, rows: 2, suffix: null, wupc: 2.2, ax: 126.8, ay: 128.4 },
    },
  },
  "Bunker": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 3.7, ax: 256, ay: 258 },
    },
  },
  "Carrier": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: null, wupc: 6.25, ax: 128, ay: 126.3 },
    },
  },
  "Changeling": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 8, rows: 8, suffix: null, wupc: 2.2, ax: 128, ay: 135.1 },
      Walk: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Walk", wupc: 4.8, ax: 128, ay: 130.2 },
    },
  },
  "Colossus": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 6.25, ax: 128, ay: 198.2 },
      Walk: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: "Walk", wupc: 6.25, ax: 128, ay: 198.1 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 8.1, ax: 128, ay: 181.9374 },
    },
  },
  "CommandCenter": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 8.1, ax: 256.5, ay: 291.6 },
    },
  },
  "Corruptor": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.67, cols: 8, rows: 8, suffix: null, wupc: 2.85, ax: 128, ay: 145.9 },
      Walk: { frames: 8, fps: 2.67, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 136.2 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 3.7, ax: 128, ay: 145.549 },
    },
  },
  "CreepTumor": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.2, cols: 4, rows: 2, suffix: null, wupc: 2.2, ax: 121, ay: 141.3 },
    },
  },
  "CreepTumorBurrowed": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 1.7, ax: 109.1, ay: 138.9 },
    },
  },
  "CyberneticsCore": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 269, ay: 291.5 },
    },
  },
  "Cyclone": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.67, cols: 8, rows: 8, suffix: null, wupc: 2.2, ax: 128, ay: 154 },
      Walk: { frames: 8, fps: 6, cols: 8, rows: 8, suffix: "Walk", wupc: 2.85, ax: 128, ay: 148.7 },
      Attack: { frames: 8, fps: 26.6667, cols: 8, rows: 8, suffix: "Attack", wupc: 2.85, ax: 128, ay: 148.3322 },
    },
  },
  "DarkShrine": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 0.48, cols: 4, rows: 2, suffix: null, wupc: 6.25, ax: 260.1, ay: 343.5 },
    },
  },
  "DarkTemplar": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 8, rows: 8, suffix: null, wupc: 2.2, ax: 128, ay: 161.8 },
      Walk: { frames: 8, fps: 10.91, cols: 8, rows: 8, suffix: "Walk", wupc: 2.2, ax: 128, ay: 170.6 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 3.7, ax: 128, ay: 153.307 },
    },
  },
  "Disruptor": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 3.43, cols: 8, rows: 8, suffix: null, wupc: 2.2, ax: 128, ay: 179.8 },
      Walk: { frames: 8, fps: 3.43, cols: 8, rows: 8, suffix: "Walk", wupc: 2.2, ax: 128, ay: 179.8 },
    },
  },
  "DisruptorPhased": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 2.85, ax: 128, ay: 164.8 },
    },
  },
  "Drone": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 1.7, ax: 128, ay: 156.1 },
      Walk: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Walk", wupc: 1.7, ax: 128, ay: 161.6 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 2.2, ax: 128, ay: 147.0801 },
    },
  },
  "Egg": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 3.48, cols: 4, rows: 2, suffix: null, wupc: 1.7, ax: 128.4, ay: 149.5 },
    },
  },
  "EngineeringBay": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 6.25, ax: 265.6, ay: 284.1 },
    },
  },
  "EvolutionChamber": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 0.8, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 256.5, ay: 288.9 },
    },
  },
  "Extractor": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 6.25, ax: 247.6, ay: 316 },
    },
  },
  "Factory": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 6.25, ax: 260.2, ay: 298.4 },
    },
  },
  "FleetBeacon": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 267.1, ay: 282.7 },
    },
  },
  "ForceField": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 3.7, ax: 128, ay: 160.7 },
    },
  },
  "Forge": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.2, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 241.4, ay: 271.4 },
    },
  },
  "FusionCore": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 0.8, cols: 4, rows: 2, suffix: null, wupc: 6.25, ax: 256, ay: 286.9 },
    },
  },
  "Gateway": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 6.25, ax: 256, ay: 256.2 },
    },
  },
  "Ghost": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 5.33, cols: 8, rows: 8, suffix: null, wupc: 1.7, ax: 128, ay: 197.1 },
      Walk: { frames: 8, fps: 12, cols: 8, rows: 8, suffix: "Walk", wupc: 2.2, ax: 128, ay: 161 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 3.7, ax: 128, ay: 154.4988 },
    },
  },
  "GhostAcademy": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.2, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 256, ay: 295.3 },
    },
  },
  "GreaterSpire": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 0.8, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 256, ay: 333.5 },
    },
  },
  "Hatchery": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.2, cols: 4, rows: 2, suffix: null, wupc: 8.1, ax: 257.4, ay: 305.1 },
    },
  },
  "Hellbat": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 5.33, cols: 8, rows: 8, suffix: null, wupc: 2.85, ax: 128, ay: 167 },
      Walk: { frames: 8, fps: 9.23, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 159.8 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 2.85, ax: 128, ay: 175.9973 },
    },
  },
  "Hellion": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 2.85, ax: 128, ay: 149 },
      Walk: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Walk", wupc: 2.85, ax: 128, ay: 149.4 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 2.85, ax: 128, ay: 148.8521 },
    },
  },
  "HighTemplar": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.67, cols: 8, rows: 8, suffix: null, wupc: 1.7, ax: 128, ay: 201.8 },
      Walk: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Walk", wupc: 1.7, ax: 128, ay: 208 },
    },
  },
  "Hive": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.2, cols: 4, rows: 2, suffix: null, wupc: 10.5, ax: 257.1, ay: 317 },
    },
  },
  "Hydralisk": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 3, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 138.4 },
      Walk: { frames: 8, fps: 4.8, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 145.8 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 3.7, ax: 128, ay: 150.2806 },
    },
  },
  "HydraliskDen": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 4.07, cols: 4, rows: 2, suffix: null, wupc: 6.25, ax: 267.1, ay: 310.7 },
    },
  },
  "Immortal": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 159 },
      Walk: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 149.4 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 3.7, ax: 128, ay: 164.0866 },
    },
  },
  "InfestationPit": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 3, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 254.9, ay: 251.2 },
    },
  },
  "InfestedTerran": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 3, cols: 8, rows: 8, suffix: null, wupc: 2.2, ax: 128, ay: 171.4 },
      Walk: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Walk", wupc: 2.85, ax: 128, ay: 151.6 },
    },
  },
  "InfestedTerranEgg": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 4, rows: 2, suffix: null, wupc: 1.7, ax: 127.9, ay: 165.1 },
    },
  },
  "Infestor": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 156.2 },
      Walk: { frames: 8, fps: 16, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 150.4 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 3.7, ax: 128, ay: 153.9679 },
    },
  },
  "Interceptor": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 8, suffix: null, wupc: 1.3, ax: 128, ay: 128.2 },
    },
  },
  "Lair": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.2, cols: 4, rows: 2, suffix: null, wupc: 10.5, ax: 257, ay: 297.9 },
    },
  },
  "Larva": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 8, rows: 8, suffix: null, wupc: 1.7, ax: 128, ay: 131.3 },
      Walk: { frames: 8, fps: 9.23, cols: 8, rows: 8, suffix: "Walk", wupc: 1.7, ax: 128, ay: 139.3 },
    },
  },
  "Liberator": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 136.9 },
      Walk: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 137.3 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 3.7, ax: 128, ay: 137.4207 },
    },
  },
  "Locust": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 3, cols: 8, rows: 8, suffix: null, wupc: 2.2, ax: 128, ay: 149.7 },
      Walk: { frames: 8, fps: 7.5, cols: 8, rows: 8, suffix: "Walk", wupc: 2.2, ax: 128, ay: 150.6 },
    },
  },
  "LocustFlying": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 3.75, cols: 8, rows: 8, suffix: null, wupc: 2.85, ax: 128, ay: 128.1 },
      Walk: { frames: 8, fps: 7.5, cols: 8, rows: 8, suffix: "Walk", wupc: 2.2, ax: 128, ay: 136.8 },
    },
  },
  "Lurker": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 154.5 },
      Walk: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 146.1 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 2.2, ax: 128, ay: 121.6165 },
    },
  },
  "LurkerDen": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.2, cols: 4, rows: 2, suffix: null, wupc: 6.25, ax: 256.9, ay: 305.5 },
    },
  },
  "LurkerEgg": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 2.85, ax: 128, ay: 140.7 },
    },
  },
  "MULE": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 2.85, ax: 128, ay: 160.4 },
      Walk: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: "Walk", wupc: 2.85, ax: 128, ay: 157.6 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 3.7, ax: 128, ay: 153.8252 },
    },
  },
  "Marauder": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.53, cols: 8, rows: 8, suffix: null, wupc: 1.7, ax: 128, ay: 167.7 },
      Walk: { frames: 8, fps: 9.23, cols: 8, rows: 8, suffix: "Walk", wupc: 1.7, ax: 128, ay: 166.7 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 2.2, ax: 128, ay: 168.1583 },
    },
  },
  "Marine": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 3, cols: 8, rows: 8, suffix: null, wupc: 1.3, ax: 128, ay: 175.9 },
      Walk: { frames: 8, fps: 12, cols: 8, rows: 8, suffix: "Walk", wupc: 1.3, ax: 128, ay: 169.3 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 1.3, ax: 128, ay: 156.065 },
    },
  },
  "Medivac": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 3.75, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 128 },
      Walk: { frames: 8, fps: 3.75, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 129.5 },
    },
  },
  "MissileTurret": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 2.2, ax: 256, ay: 324.7 },
    },
  },
  "Mothership": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 24, cols: 8, rows: 8, suffix: null, wupc: 13.7, ax: 128, ay: 143.9 },
      Walk: { frames: 8, fps: 24, cols: 8, rows: 8, suffix: "Walk", wupc: 13.7, ax: 128, ay: 143.6 },
    },
  },
  "Mutalisk": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 4.8, ax: 128, ay: 155.2 },
      Walk: { frames: 8, fps: 3.69, cols: 8, rows: 8, suffix: "Walk", wupc: 4.8, ax: 128, ay: 156.3 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 4.8, ax: 128, ay: 156.1801 },
    },
  },
  "Nexus": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.5, cols: 4, rows: 2, suffix: null, wupc: 8.1, ax: 256, ay: 256 },
    },
  },
  "Nuke": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 8, suffix: null, wupc: 1.7, ax: 128, ay: 216.7 },
    },
  },
  "NydusCanal": {
    kind: "unit",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 256.2, ay: 318.2 },
    },
  },
  "NydusNetwork": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 6.25, ax: 274.3, ay: 300.8 },
    },
  },
  "Observer": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 5.33, cols: 8, rows: 8, suffix: null, wupc: 2.2, ax: 128, ay: 128.5 },
      Walk: { frames: 8, fps: 5.33, cols: 8, rows: 8, suffix: "Walk", wupc: 1.7, ax: 128, ay: 129 },
    },
  },
  "Oracle": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 5.33, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 138.1 },
      Walk: { frames: 8, fps: 5.33, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 117.1 },
    },
  },
  "OrbitalCommand": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 0.6, cols: 4, rows: 2, suffix: null, wupc: 8.1, ax: 256.5, ay: 292.7 },
    },
  },
  "Overlord": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: null, wupc: 2.85, ax: 128, ay: 137 },
      Walk: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 129.4 },
    },
  },
  "OverlordCocoon": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.6, cols: 4, rows: 2, suffix: null, wupc: 2.2, ax: 126.8, ay: 128.4 },
    },
  },
  "Overseer": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 132.4 },
      Walk: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: "Walk", wupc: 2.85, ax: 128, ay: 140.5 },
    },
  },
  "Phoenix": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: null, wupc: 2.85, ax: 128, ay: 132 },
      Walk: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: "Walk", wupc: 2.85, ax: 128, ay: 131.4 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 3.7, ax: 128, ay: 130.4114 },
    },
  },
  "PhotonCannon": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 3.7, ax: 262.7, ay: 250.4 },
    },
  },
  "PlanetaryFortress": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 0.4, cols: 4, rows: 2, suffix: null, wupc: 8.1, ax: 256.5, ay: 304.3 },
    },
  },
  "PointDefenseDrone": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 2.85, ax: 128, ay: 149.3 },
    },
  },
  "Probe": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 6, cols: 8, rows: 8, suffix: null, wupc: 1.7, ax: 128, ay: 169.2 },
      Walk: { frames: 8, fps: 3, cols: 8, rows: 8, suffix: "Walk", wupc: 1.7, ax: 128, ay: 175.8 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 1.7, ax: 128, ay: 170.3814 },
    },
  },
  "Pylon": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 0.6, cols: 4, rows: 2, suffix: null, wupc: 2.85, ax: 256.3, ay: 371.8 },
    },
  },
  "Queen": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 4.8, ax: 128, ay: 145.4 },
      Walk: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Walk", wupc: 4.8, ax: 128, ay: 148.2 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 10.5, ax: 128, ay: 134.0322 },
    },
  },
  "Ravager": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 153.9 },
      Walk: { frames: 8, fps: 4.8, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 142.9 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 4.8, ax: 128, ay: 155.1543 },
    },
  },
  "RavagerCocoon": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 2.85, ax: 129.2, ay: 141.6 },
    },
  },
  "Raven": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 147.3 },
      Walk: { frames: 8, fps: 5.33, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 146.8 },
    },
  },
  "Reactor": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 3.7, ax: 332.3, ay: 246.2 },
    },
  },
  "Reaper": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 3, cols: 8, rows: 8, suffix: null, wupc: 2.2, ax: 128, ay: 147.8 },
      Walk: { frames: 8, fps: 6, cols: 8, rows: 8, suffix: "Walk", wupc: 2.2, ax: 128, ay: 152.6 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 2.2, ax: 128, ay: 144.9194 },
    },
  },
  "Refinery": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 4, rows: 2, suffix: null, wupc: 6.25, ax: 256, ay: 298.8 },
    },
  },
  "Roach": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 2.2, ax: 128, ay: 146.3 },
      Walk: { frames: 8, fps: 18.46, cols: 8, rows: 8, suffix: "Walk", wupc: 2.2, ax: 128, ay: 139.3 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 2.2, ax: 128, ay: 153.7397 },
    },
  },
  "RoachWarren": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 258.5, ay: 293.8 },
    },
  },
  "RoboticsBay": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 3.7, ax: 236.4, ay: 312.8 },
    },
  },
  "RoboticsFacility": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 256, ay: 272 },
    },
  },
  "SCV": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 2.2, ax: 128, ay: 160.7 },
      Walk: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Walk", wupc: 2.2, ax: 128, ay: 149.2 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 2.85, ax: 128, ay: 148.3637 },
    },
  },
  "Sentry": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: null, wupc: 2.85, ax: 128, ay: 162.1 },
      Walk: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: "Walk", wupc: 2.85, ax: 128, ay: 161.4 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 3.7, ax: 128, ay: 155.8096 },
    },
  },
  "ShieldBattery": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.04, cols: 4, rows: 2, suffix: null, wupc: 3.7, ax: 256.3, ay: 238.3 },
    },
  },
  "SiegeTank": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 8, rows: 8, suffix: null, wupc: 4.8, ax: 128, ay: 149 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 4.8, ax: 128, ay: 148.7684 },
    },
  },
  "SpawningPool": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 0.3, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 256, ay: 282.8 },
    },
  },
  "SpineCrawler": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.18, cols: 4, rows: 2, suffix: null, wupc: 3.7, ax: 256.1, ay: 271.8 },
    },
  },
  "Spire": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.6, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 258.3, ay: 327.9 },
    },
  },
  "SporeCrawler": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.18, cols: 4, rows: 2, suffix: null, wupc: 3.7, ax: 255.7, ay: 280.6 },
    },
  },
  "Stalker": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 148.1 },
      Walk: { frames: 8, fps: 12, cols: 8, rows: 8, suffix: "Walk", wupc: 4.8, ax: 128, ay: 129.8 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 3.7, ax: 128, ay: 151.4962 },
    },
  },
  "Stargate": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 6.25, ax: 256, ay: 340.3 },
    },
  },
  "Starport": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 6.25, ax: 256, ay: 346.9 },
    },
  },
  "StasisWard": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.6, cols: 4, rows: 2, suffix: null, wupc: 2.2, ax: 126.4, ay: 183.4 },
    },
  },
  "SupplyDepot": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.2, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 256, ay: 254.9 },
      Birth: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: "Birth", wupc: 4.8, ax: 256, ay: 254.9 },
    },
  },
  "SwarmHost": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: null, wupc: 2.85, ax: 128, ay: 152.8 },
      Walk: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 151.9 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 3.7, ax: 128, ay: 150.8665 },
    },
  },
  "TechLab": {
    kind: "building",
    race: "Terran",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 3.7, ax: 343.1, ay: 279.8 },
    },
  },
  "Tempest": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: null, wupc: 4.8, ax: 128, ay: 128 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 4.8, ax: 128, ay: 128 },
    },
  },
  "TemplarArchive": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 4.8, ax: 256, ay: 273.8 },
    },
  },
  "Thor": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: null, wupc: 8.1, ax: 128, ay: 159.7 },
      Walk: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: "Walk", wupc: 8.1, ax: 128, ay: 164.3 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 8.1, ax: 128, ay: 155.5667 },
    },
  },
  "TransportOverlord": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 1.41, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 147.3 },
      Walk: { frames: 8, fps: 1.85, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 142.1 },
    },
  },
  "TwilightCouncil": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 1.2, cols: 4, rows: 2, suffix: null, wupc: 6.25, ax: 256, ay: 283.5 },
    },
  },
  "Ultralisk": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: null, wupc: 8.1, ax: 128, ay: 149.6 },
      Walk: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Walk", wupc: 8.1, ax: 128, ay: 153.9 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 10.5, ax: 128, ay: 127.0814 },
    },
  },
  "UltraliskCavern": {
    kind: "building",
    race: "Zerg",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 4, rows: 2, suffix: null, wupc: 6.25, ax: 255.7, ay: 296.8 },
    },
  },
  "Viking": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.26, cols: 8, rows: 8, suffix: null, wupc: 2.85, ax: 128, ay: 123.5 },
      Walk: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Walk", wupc: 2.85, ax: 128, ay: 123.5 },
    },
  },
  "Viper": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: null, wupc: 8.1, ax: 128, ay: 123.6 },
      Walk: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: "Walk", wupc: 8.1, ax: 128, ay: 124.8 },
    },
  },
  "VoidRay": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: null, wupc: 3.7, ax: 128, ay: 140.8 },
      Walk: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: "Walk", wupc: 3.7, ax: 128, ay: 140.6 },
      Attack: { frames: 8, fps: 10.4348, cols: 8, rows: 8, suffix: "Attack", wupc: 6.25, ax: 128, ay: 128 },
    },
  },
  "WarpGate": {
    kind: "building",
    race: "Protoss",
    frameSize: 512,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 6.25, ax: 256, ay: 256.2 },
    },
  },
  "WarpPrism": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: null, wupc: 4.8, ax: 128, ay: 123 },
      Walk: { frames: 8, fps: 2, cols: 8, rows: 8, suffix: "Walk", wupc: 4.8, ax: 128, ay: 123 },
    },
  },
  "WidowMine": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 5.33, cols: 8, rows: 8, suffix: null, wupc: 2.2, ax: 128, ay: 142.9 },
      Walk: { frames: 8, fps: 18.46, cols: 8, rows: 8, suffix: "Walk", wupc: 2.2, ax: 128, ay: 142.9 },
    },
  },
  "WidowMineBurrowed": {
    kind: "unit",
    race: "Terran",
    frameSize: 256,
    facings: 1,
    anims: {
      Stand: { frames: 1, fps: 0, cols: 1, rows: 1, suffix: null, wupc: 1.3, ax: 128, ay: 141 },
    },
  },
  "Zealot": {
    kind: "unit",
    race: "Protoss",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.4, cols: 8, rows: 8, suffix: null, wupc: 1.7, ax: 128, ay: 160.9 },
      Walk: { frames: 8, fps: 10.91, cols: 8, rows: 8, suffix: "Walk", wupc: 1.7, ax: 128, ay: 158.7 },
      Attack: { frames: 8, fps: 8, cols: 8, rows: 8, suffix: "Attack", wupc: 2.85, ax: 128, ay: 152.3701 },
    },
  },
  "Zergling": {
    kind: "unit",
    race: "Zerg",
    frameSize: 256,
    facings: 8,
    anims: {
      Stand: { frames: 8, fps: 2.67, cols: 8, rows: 8, suffix: null, wupc: 1.7, ax: 128, ay: 154.4 },
      Walk: { frames: 8, fps: 4, cols: 8, rows: 8, suffix: "Walk", wupc: 2.85, ax: 128, ay: 137.1 },
      Attack: { frames: 8, fps: 15, cols: 8, rows: 8, suffix: "Attack", wupc: 2.85, ax: 128, ay: 140.9487 },
    },
  },
};
