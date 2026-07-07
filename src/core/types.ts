// Shared types. Kept narrow on purpose; new fields go on the entity definitions
// (config/) when they're data, or on the FSM state when they're behavioral.

export type EntityId = number;
export type PlayerId = number; // 0 = Gaia/neutral, 1 = player, 2+ = enemies

export interface Vec2 { x: number; y: number; }
export interface TilePos { tx: number; ty: number; }

export type Faction = 'gaia' | 'player' | 'enemy';

export type ResourceKind = 'wood' | 'food' | 'gold' | 'stone';
export type ResourceBag = Record<ResourceKind, number>;

export type EntityKind = 'unit' | 'building' | 'resource';

// What a unit is currently doing. Drives the FSM in systems/unitFSM.
export type UnitState =
  | { kind: 'idle' }
  | {
      kind: 'moving'; path: TilePos[]; pathIndex: number; finalTarget: Vec2;
      /** Seconds of no progress toward the next waypoint (stuck detection). */
      stuck?: number;
      /** Distance to next waypoint last tick — progress baseline. */
      lastDist?: number;
    }
  | { kind: 'gathering'; targetId: EntityId; resource: ResourceKind }
  | { kind: 'returning'; targetId: EntityId; resource: ResourceKind }
  | { kind: 'building'; targetId: EntityId }
  | { kind: 'attacking'; targetId: EntityId }
  | { kind: 'attackMove'; finalTarget: Vec2 };

// Issued by player commands or AI; the FSM consumes them.
export type Command =
  | { kind: 'move'; pos: Vec2 }
  | { kind: 'attackMove'; pos: Vec2 }
  | { kind: 'gather'; targetId: EntityId }
  | { kind: 'returnResource'; targetId: EntityId }
  | { kind: 'build'; targetId: EntityId }
  | { kind: 'attack'; targetId: EntityId }
  | { kind: 'stop' };

// All world entities share this base. Per-kind specific fields are optional
// here; the renderer/systems narrow on `kind` and on entity type id.
export interface Entity {
  id: EntityId;
  kind: EntityKind;
  typeId: string;              // 'villager', 'town_center', 'tree', ...
  owner: PlayerId;
  pos: Vec2;                   // world coords, in pixels
  radius: number;              // for unit collisions / clicking
  hp: number;
  maxHp: number;

  // Tile footprint (buildings + resources occupy tiles; units do not).
  footprintTiles?: TilePos[];
  tilePos?: TilePos;           // top-left tile of footprint
  sizeTiles?: { w: number; h: number };

  // Unit-only behavior.
  state?: UnitState;
  commandQueue?: Command[];
  speed?: number;              // pixels/sec
  attackDmg?: number;
  attackRange?: number;        // pixels
  attackSpeed?: number;        // attacks per second
  lastAttackAt?: number;       // sim time (s)
  /** Stunned (Indrastra etc.): FSM is frozen until this sim time. */
  stunnedUntil?: number;
  /** Throttle for attack-move target scans (sim time). */
  nextAcquireAt?: number;
  /** Throttle for A* re-paths while blocked/chasing (sim time). */
  nextRepathAt?: number;
  /** Throttle for AI controllers re-ordering this unit (sim time). */
  nextOrderAt?: number;

  // Gatherer carrying capacity.
  carrying?: { resource: ResourceKind; amount: number };
  gatherRate?: number;         // resource units / second
  gatherCapacity?: number;     // max carry before returning
  /** Build-speed multiplier (techs). 1 = normal. */
  buildSpeed?: number;
  /** Flat damage reduction. Stamped from the def at spawn; techs mutate it. */
  armor?: number;

  // Building-only.
  isConstructionSite?: boolean;
  buildProgress?: number;      // 0..1
  buildTime?: number;          // seconds total
  productionQueue?: ProductionOrder[];
  rallyPoint?: Vec2;
  providesPop?: number;
  isDropoff?: boolean;         // accepts resource deposits
  acceptedResources?: ResourceKind[];
  /** Gate-only: true while the gate stands open (footprint tiles freed). */
  gateOpen?: boolean;

  // Resource-node only.
  resourceKind?: ResourceKind;
  resourceRemaining?: number;

  // Lifecycle.
  dead?: boolean;
  deathAt?: number;            // sim time when killed
  selectable: boolean;

  // Facing: -1 means facing left, +1 means facing right, 0 unknown.
  facing?: -1 | 0 | 1;
  // Facing as an angle in radians; 0 = east, π/2 = south. Updated from
  // velocity during tickMoving. Smoothed so the unit doesn't pop directions
  // mid-stride.
  facingAngle?: number;
  // Last tick's position so we can derive velocity for facing & breathing.
  prevX?: number;

  // Hero-only: when each special ability was last cast (sim time). Used to
  // gate cooldowns. `abilities[key]` undefined = ready.
  abilityLastUsed?: Record<string, number>;
}

export interface ProductionOrder {
  /** 'unit' (default) trains typeId; 'tech' researches TECH_DEFS[typeId]. */
  kind?: 'unit' | 'tech';
  typeId: string;          // unit typeId or tech id
  progress: number;        // 0..1
  buildTime: number;       // seconds
  cost: Partial<ResourceBag>;
}
