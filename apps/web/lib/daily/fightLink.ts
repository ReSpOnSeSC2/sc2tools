import { FIGHTS_PER_DAY } from "./rules";

const FIGHT_LINK = /^#fight=([1-9][0-9]{0,5})-([1-5])$/;

export function readFightLink(hash: string, today: number): { day: number; slot: number } | null {
  const match = FIGHT_LINK.exec(hash);
  const day = Number(match?.[1]), slot = Number(match?.[2]) - 1;
  return Number.isInteger(day) && day <= today && slot < FIGHTS_PER_DAY ? { day, slot } : null;
}

export function dailyFightLink(day: number, slot: number): string {
  return "/arcade#fight=" + day + "-" + (slot + 1);
}
