// ═══════════════════════════════════════════════════════════════
// gameState.ts — Definitive Hybrid Architecture
// Backend logic only. No Three.js/rendering code lives here.
// Distance math is unified: Chebyshev distance is used EVERYWHERE
// (adjacency, spell range, property auras, combat range).
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// ENUMS & PRIMITIVES
// ─────────────────────────────────────────────────────────────

export type HeroClass = 'WARLORD' | 'ENGINEER' | 'NECROMANCER';

export type UnitClass =
  | 'MERCENARY' | 'SNIPER'           // Warlord
  | 'CONSTRUCT' | 'DRONE'            // Engineer
  | 'UNDEAD';                        // Necromancer

export type TileType = 'NORMAL' | 'WALL' | 'VOID';

export type PropertyType =
  | 'NONE'
  | 'WARLORD_SHRINE'
  | 'ENGINEER_TOWER'
  | 'NECROMANCER_ALTAR';

export type GamePhase =
  | 'ESSENCE_GENERATION'
  | 'UPKEEP'
  | 'HERO_FREE_ACTION'
  | 'DICE_ROLL'
  | 'DICE_ASSIGNMENT'
  | 'END_TURN'
  | 'GAME_OVER';

export type EffectExpiry = 'NEXT_DAMAGE' | 'END_OF_TURN' | 'INSTANT';

export type ActionTargetType =
  | 'UNIT' | 'HERO_SPELL' | 'SPAWN' | 'UPGRADE_PROPERTY' | 'UNASSIGNED';

export type AbilityId =
  | 'WARLORD_BLESS' | 'WARLORD_CURSE' | 'WARLORD_RALLY' | 'WARLORD_EXECUTE'
  | 'ENGINEER_BLESS' | 'ENGINEER_CURSE' | 'ENGINEER_FORTIFY' | 'ENGINEER_OVERCLOCK'
  | 'NECROMANCER_BLESS' | 'NECROMANCER_CURSE' | 'NECROMANCER_SACRIFICE' | 'NECROMANCER_SHADOWSTEP';

// ─────────────────────────────────────────────────────────────
// STATIC BALANCE TABLES
// ─────────────────────────────────────────────────────────────

export interface StatBlock {
  hp: number;
  atk: number;
  def: number;
}

export const HERO_BASE_STATS: StatBlock = { hp: 20, atk: 4, def: 2 };

export const UNIT_STATS: Record<UnitClass, StatBlock & {
  moveRange: number;
  attackRange: number; // 1 = melee/adjacent
}> = {
  UNDEAD:     { hp: 3, atk: 2, def: 1, moveRange: 4, attackRange: 1 },
  CONSTRUCT:  { hp: 6, atk: 2, def: 3, moveRange: 4, attackRange: 1 },
  DRONE:      { hp: 5, atk: 0, def: 2, moveRange: 3, attackRange: 0 }, // cannot attack
  MERCENARY:  { hp: 6, atk: 4, def: 2, moveRange: 4, attackRange: 1 },
  SNIPER:     { hp: 6, atk: 4, def: 1, moveRange: 3, attackRange: 3 },
};

export const SPAWN_THRESHOLDS: Record<UnitClass, number> = {
  UNDEAD: 2,
  CONSTRUCT: 3,
  DRONE: 2,
  MERCENARY: 5,
  SNIPER: 5,
};

export interface SpawnCost {
  essence: number;
  heroHp: number;
}
export const SPAWN_COSTS: Record<UnitClass, SpawnCost> = {
  UNDEAD:     { essence: 0, heroHp: 3 },
  CONSTRUCT:  { essence: 3, heroHp: 0 },
  DRONE:      { essence: 2, heroHp: 0 },
  MERCENARY:  { essence: 5, heroHp: 0 },
  SNIPER:     { essence: 5, heroHp: 0 },
};

export const UPKEEP_COST: Partial<Record<UnitClass, number>> = {
  MERCENARY: 2,
  SNIPER: 2,
};

export const UNIT_CLASS_OWNER: Record<UnitClass, HeroClass> = {
  UNDEAD: 'NECROMANCER',
  CONSTRUCT: 'ENGINEER',
  DRONE: 'ENGINEER',
  MERCENARY: 'WARLORD',
  SNIPER: 'WARLORD',
};

export const ESSENCE_PER_NORMAL_TILE = 1;
export const HERO_SACRIFICE_HP_GAIN = 3;
export const MAX_UNITS_PER_PLAYER = 5;
export const BOARD_SIZE = 12;
export const VOID_ZONE_START_TURN = 15;
export const VOID_ZONE_SHRINK_INTERVAL = 5;
export const VOID_ZONE_DAMAGE = 5;
export const DAMAGE_FLOOR = 1;
export const SPELL_RANGE = 3; // Bless/Curse/Rally/Fortify/Overclock — Chebyshev, Wall-blocked LoS

// Property Upgrades — adjacency is now UNIFIED Chebyshev distance === 1 (not orthogonal)
export interface PropertyStats {
  essenceBonus: number;
  essenceCost: number;
  buildThreshold: number;
}
export const PROPERTY_STATS: Record<Exclude<PropertyType, 'NONE'>, PropertyStats> = {
  WARLORD_SHRINE:      { essenceBonus: 1, essenceCost: 4, buildThreshold: 3 },
  ENGINEER_TOWER:      { essenceBonus: 1, essenceCost: 4, buildThreshold: 3 },
  NECROMANCER_ALTAR:   { essenceBonus: 1, essenceCost: 4, buildThreshold: 3 },
};

export const ENGINEER_TOWER_ADJACENT_DEF_BONUS = 1;
export const WARLORD_SHRINE_UPKEEP_REDUCTION = 1;
export const NECROMANCER_ALTAR_SIPHON_HEAL = 1;

// New ability constants
export const WARLORD_RALLY_THRESHOLD = 4;
export const WARLORD_RALLY_MOVE_TILES = 2;
export const WARLORD_EXECUTE_THRESHOLD = 5;
export const WARLORD_EXECUTE_HP_CEILING = 2; // instakills targets at or below this HP
export const ENGINEER_FORTIFY_THRESHOLD = 3;
export const ENGINEER_OVERCLOCK_THRESHOLD = 4;
export const ENGINEER_OVERCLOCK_ATK_BONUS = 2;
export const ENGINEER_OVERCLOCK_RECOIL_DAMAGE = 1; // unblockable, end of turn

// ─────────────────────────────────────────────────────────────
// CORE ENTITIES
// ─────────────────────────────────────────────────────────────

export interface TempEffect {
  stat: 'HP' | 'ATK' | 'DEF' | 'MOVE';
  amount: number;
  expiresOn: EffectExpiry;
  sourceAbility: AbilityId;
}

// Scheduled, non-stat effects that resolve at a specific phase rather than
// modifying a stat directly (e.g. Overclock recoil). Kept separate from
// TempEffect to avoid overloading that type with non-stat semantics.
export interface ScheduledEffect {
  kind: 'UNBLOCKABLE_DAMAGE';
  amount: number;
  resolvesAtPhase: 'END_TURN';
  sourceAbility: AbilityId;
}

// Tile-level temporary effect — currently only used by Engineer Fortify.
// Kept distinct from Tile.type itself so the tile's TRUE type is preserved
// underneath and can be restored automatically on expiry.
export interface TileTempEffect {
  treatAsType: TileType; // 'WALL' for Fortify
  expiresOnTurnNumber: number; // absolute turn number this clears (start of caster's next turn)
  sourceAbility: AbilityId;
  casterId: string;
}

export interface Tile {
  x: number;
  y: number;
  type: TileType;

  ownerId: string | null;
  infusionTag: { heroId: string; heroClass: HeroClass } | null;

  property: PropertyType;
  propertyOwnerId: string | null;

  hasCorpse: boolean;
  bomb: { ownerId: string } | null;

  tempEffect: TileTempEffect | null; // Fortify lives here; null otherwise
}

export interface UnitActivation {
  diePipsAssigned: number | null;
  pipsRemaining: number;
  hasActedThisTurn: boolean;
}

export interface Unit {
  id: string;
  ownerId: string;
  unitClass: UnitClass;

  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  moveRange: number;
  attackRange: number;

  x: number;
  y: number;

  activation: UnitActivation;
  tempEffects: TempEffect[];
  scheduledEffects: ScheduledEffect[]; // Overclock recoil lives here

  canAttack: boolean;
  canCaptureTerritory: boolean;
  isUpkeepUnit: boolean;
}

export interface Hero {
  id: string;
  ownerId: string;
  heroClass: HeroClass;

  hp: number;
  maxHp: number;
  atk: number;
  def: number;

  x: number;
  y: number;

  freeActionUsed: boolean;
  tempEffects: TempEffect[];

  abilitiesUsedThisTurn: AbilityId[]; // tracks Sacrifice/Shadowstep (free-action-tied, not die-gated)
}

export interface Die {
  id: string;
  faceValue: number; // 1-6

  assignedTo: {
    targetType: ActionTargetType;
    targetId: string | null;
    abilityId: AbilityId | null;
    spawnClass: UnitClass | null;
    propertyType: PropertyType | null;
    targetTile: { x: number; y: number } | null;
  };

  consumed: boolean;
}

export interface Player {
  id: string;
  heroId: string;
  essence: number; // UI-relabeled "Mana" when heroClass === 'NECROMANCER'

  ownedTileCoords: { x: number; y: number }[];
  unitIds: string[]; // enforce length <= MAX_UNITS_PER_PLAYER at spawn-time

  isEliminated: boolean;
}

export interface VoidZoneState {
  active: boolean;
  ringsShrunk: number;
}

export interface GameState {
  turnNumber: number;
  activePlayerId: string;
  phase: GamePhase;

  board: {
    width: typeof BOARD_SIZE;
    height: typeof BOARD_SIZE;
    tiles: Tile[]; // flat array, length 144
  };

  players: [Player, Player]; // strictly 2
  heroes: Hero[];
  units: Unit[];

  currentDiceRoll: Die[];

  voidZone: VoidZoneState;

  winnerId: string | null;
  gameOver: boolean;
}

// ─────────────────────────────────────────────────────────────
// SHARED UTILITIES (pure functions, no state mutation)
// ─────────────────────────────────────────────────────────────

export function chebyshevDistance(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function computeDamage(atk: number, def: number): number {
  return Math.max(DAMAGE_FLOOR, atk - def);
}
