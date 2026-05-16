import type { ComponentType, SVGProps } from "react";
import {
  ArcadeIcon,
  BuildsIcon,
  MapsIcon,
  OpponentsIcon,
  StrategiesIcon,
  TrendsIcon,
} from "./icons/NavIcons";

export type TabId =
  | "opponents"
  | "strategies"
  | "trends"
  | "battlefield"
  | "builds"
  | "arcade";

export type NavIconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export type TabDef = {
  id: TabId;
  label: string;
  icon: NavIconComponent;
  description?: string;
};

export const TABS: readonly TabDef[] = [
  { id: "opponents", label: "Opponents", icon: OpponentsIcon, description: "Drill into the players you've faced." },
  { id: "strategies", label: "Strategies", icon: StrategiesIcon, description: "Build vs strategy and per-strategy results." },
  { id: "trends", label: "Trends", icon: TrendsIcon, description: "Win-rate trajectory across periods." },
  { id: "battlefield", label: "Maps", icon: MapsIcon, description: "Maps and matchup performance." },
  { id: "builds", label: "Builds", icon: BuildsIcon, description: "Your builds, performance, and editor." },
  { id: "arcade", label: "Arcade", icon: ArcadeIcon, description: "Quizzes and games that go deeper than the charts." },
] as const;
