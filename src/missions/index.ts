// Mission registry. Campaign order matters: mission N unlocks when its
// `requires` list is complete (tracked in localStorage by the shell).

import type { MissionDef } from '@/missions/types';
import { balaKanda } from '@/missions/balaKanda';
import { aranyaKanda } from '@/missions/aranyaKanda';
import { yuddhaKanda } from '@/missions/yuddhaKanda';

export const MISSIONS: MissionDef[] = [
  balaKanda,
  aranyaKanda,
  yuddhaKanda,
];

export function getMission(id: string): MissionDef | undefined {
  return MISSIONS.find(m => m.id === id);
}

export const DEFAULT_MISSION_ID = MISSIONS[0].id;
