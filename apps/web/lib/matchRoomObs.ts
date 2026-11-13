import { availableMapImages } from "./map-images";
import type { Room } from "./matchRoom";

const ladderTitles = new Map(availableMapImages().flatMap(({ displayName, seasons }) =>
  seasons.length ? [[displayName, displayName] as const] : []));

export function obsMapLabel(value: string, index: number): string {
  return ladderTitles.get(value) ?? `Map ${index + 1}`;
}

function vetoMaps(room: Room) {
  const moves = new Map(room.moves.map(({ map, seat, kind }) => [map, { seat, kind }]));
  return room.config.maps.map((name, index) => ({ label: obsMapLabel(name, index), move: moves.get(index) }));
}

export function roomObsState(room: Room) {
  const playing = room.phase === "play" || room.phase === "complete";
  const nextMap = room.order[room.winners.length];
  return {
    phase: room.phase,
    bestOf: room.config.format,
    readyCount: Number(room.ready.a) + Number(room.ready.b),
    score: { a: room.score.a, b: room.score.b },
    turn: room.turn && { seat: room.turn.seat, kind: room.turn.kind },
    maps: playing ? [] : vetoMaps(room),
    nextMap: room.phase === "play" && nextMap !== undefined ? obsMapLabel(room.config.maps[nextMap], nextMap) : null,
  };
}
