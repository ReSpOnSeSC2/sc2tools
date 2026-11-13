export const ROOM_PATH = "/match/room";
export const ROOM_OBS_PATH = "/overlay/match-room";
// Next can resolve percent-encoded characters in the static path too.
export const ROOM_ROUTE = /^\/(?:m|%6d)(?:a|%61)(?:t|%74)(?:c|%63)(?:h|%68)\/(?:r|%72)(?:o|%6f)(?:o|%6f)(?:m|%6d)(?:\/|$)/i;

export function isRoomObsPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  try {
    const decoded = decodeURI(pathname).toLowerCase();
    return decoded === ROOM_OBS_PATH || decoded === ROOM_OBS_PATH + "/";
  } catch {
    return false;
  }
}
