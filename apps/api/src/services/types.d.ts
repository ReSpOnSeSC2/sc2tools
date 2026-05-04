// Service interfaces consumed by route handlers. Pure type-only
// declarations — no runtime exports.

export interface UsersService {
  ensureFromClerk(clerkUserId: string): Promise<{ userId: string }>;
  touch(userId: string): Promise<void>;
}

export interface OpponentsService {
  list(
    userId: string,
    opts?: { limit?: number; before?: Date },
  ): Promise<{ items: object[]; nextBefore: Date | null }>;
  get(userId: string, pulseId: string): Promise<object | null>;
  recordGame(
    userId: string,
    game: {
      pulseId: string;
      displayName: string;
      race: string;
      mmr?: number;
      leagueId?: number;
      result: "Victory" | "Defeat" | "Tie";
      opening?: string;
      playedAt: Date;
    },
  ): Promise<void>;
}

export interface GamesService {
  list(
    userId: string,
    opts?: { limit?: number; before?: Date; oppPulseId?: string },
  ): Promise<{ items: object[]; nextBefore: Date | null }>;
  get(userId: string, gameId: string): Promise<object | null>;
  upsert(userId: string, game: object & { gameId: string }): Promise<boolean>;
  stats(userId: string): Promise<{ total: number; latest: Date | null }>;
}

export interface CustomBuildsService {
  list(userId: string): Promise<object[]>;
  get(userId: string, slug: string): Promise<object | null>;
  upsert(userId: string, build: object & { slug: string }): Promise<void>;
  softDelete(userId: string, slug: string): Promise<void>;
}

export interface DevicePairingsService {
  start(): Promise<{ code: string; expiresAt: Date }>;
  claim(userId: string, code: string): Promise<void>;
  poll(
    code: string,
  ): Promise<
    | { status: "pending" }
    | { status: "expired" }
    | { status: "ready"; deviceToken: string; userId: string }
  >;
  findTokenByHash(hash: string): Promise<{ userId: string } | null>;
  listDevices(userId: string): Promise<object[]>;
  revoke(userId: string, tokenHash: string): Promise<void>;
}

export interface OverlayTokensService {
  create(userId: string, label: string): Promise<object>;
  list(userId: string): Promise<object[]>;
  resolve(token: string): Promise<{ userId: string; label: string } | null>;
  revoke(userId: string, token: string): Promise<void>;
}
