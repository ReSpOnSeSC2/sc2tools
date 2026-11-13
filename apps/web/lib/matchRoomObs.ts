import type { Room } from "./matchRoom";

export function obsMapLabel(value: string, index: number, ladderTitles: readonly string[]): string {
  return ladderTitles.find(title => title === value) ?? `Map ${index + 1}`;
}

function vetoMaps(room: Room, ladderTitles: readonly string[]) {
  const moves = new Map(room.moves.map(({ map, seat, kind }) => [map, { seat, kind }]));
  return room.config.maps.map((name, index) => ({ label: obsMapLabel(name, index, ladderTitles), move: moves.get(index) }));
}

export function roomObsState(room: Room, ladderTitles: readonly string[]) {
  const playing = room.phase === "play" || room.phase === "complete";
  const nextMap = room.order[room.winners.length];
  return {
    phase: room.phase,
    bestOf: room.config.format,
    readyCount: Number(room.ready.a) + Number(room.ready.b),
    score: { a: room.score.a, b: room.score.b },
    turn: room.turn && { seat: room.turn.seat, kind: room.turn.kind },
    maps: playing ? [] : vetoMaps(room, ladderTitles),
    nextMap: room.phase === "play" && nextMap !== undefined ? obsMapLabel(room.config.maps[nextMap], nextMap, ladderTitles) : null,
  };
}
