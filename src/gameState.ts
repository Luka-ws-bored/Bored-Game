export type CommanderType = 'Warlord' | 'Necromancer' | 'Engineer';
export type UnderlingType = 'Standard' | 'Mercenary' | 'Sniper';
export type UnitKind = 'commander' | 'underling';
export type Phase = 'DEPLOY' | 'MOVE' | 'ACTION';

export const GRID_SIZE = 12;
export const STARTING_CASH = 10;
export const CASH_PER_TURN = 4;

export interface Unit {
  id: number;
  kind: UnitKind;
  type: CommanderType | UnderlingType;
  ownerId: number;
  gridX: number;
  gridY: number;
  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  hasActed: boolean;
}

export interface Player {
  id: number;
  name: string;
  color: number;
  commanderType: CommanderType;
  cash: number;
}

export interface GameState {
  gridSize: number;
  players: Player[];
  units: Unit[];
  activePlayerIndex: number;
  phase: Phase;
  turnNumber: number;
  nextUnitId: number;
}

export const COMMANDER_STATS: Record<CommanderType, { hp: number; atk: number; def: number }> = {
  Warlord: { hp: 20, atk: 5, def: 3 },
  Necromancer: { hp: 16, atk: 4, def: 2 },
  Engineer: { hp: 18, atk: 3, def: 4 },
};

export const UNDERLING_STATS: Record<UnderlingType, { hp: number; atk: number; def: number; cost: number }> = {
  Standard: { hp: 8, atk: 3, def: 1, cost: 3 },
  Mercenary: { hp: 10, atk: 4, def: 2, cost: 5 },
  Sniper: { hp: 6, atk: 6, def: 1, cost: 6 },
};

export const PHASE_ORDER: Phase[] = ['DEPLOY', 'MOVE', 'ACTION'];

const PLAYER_COLORS = [0x4488ff, 0xff4466, 0x44cc88];
const COMMANDER_TYPES: CommanderType[] = ['Warlord', 'Necromancer', 'Engineer'];
const COMMANDER_STARTS: { gridX: number; gridY: number }[] = [
  { gridX: 2, gridY: 2 },
  { gridX: 6, gridY: 5 },
  { gridX: 9, gridY: 9 },
];

export function createInitialState(): GameState {
  const players: Player[] = [];
  const units: Unit[] = [];
  let nextUnitId = 1;

  for (let i = 0; i < 3; i++) {
    const cmdType = COMMANDER_TYPES[i];
    const stats = COMMANDER_STATS[cmdType];
    players.push({
      id: i,
      name: `player-${i + 1}`,
      color: PLAYER_COLORS[i],
      commanderType: cmdType,
      cash: STARTING_CASH,
    });
    const start = COMMANDER_STARTS[i];
    units.push({
      id: nextUnitId++,
      kind: 'commander',
      type: cmdType,
      ownerId: i,
      gridX: start.gridX,
      gridY: start.gridY,
      hp: stats.hp,
      maxHp: stats.hp,
      atk: stats.atk,
      def: stats.def,
      hasActed: false,
    });
  }

  return {
    gridSize: GRID_SIZE,
    players,
    units,
    activePlayerIndex: 0,
    phase: 'DEPLOY',
    turnNumber: 1,
    nextUnitId,
  };
}

export function getUnitAt(state: GameState, gx: number, gy: number): Unit | undefined {
  return state.units.find((u) => u.gridX === gx && u.gridY === gy);
}

export function chebyshevDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

export function getAdjacentTiles(gx: number, gy: number): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      tiles.push({ x: gx + dx, y: gy + dy });
    }
  }
  return tiles;
}

export function getDeployTiles(state: GameState, playerId: number): { x: number; y: number }[] {
  const commander = state.units.find((u) => u.ownerId === playerId && u.kind === 'commander');
  if (!commander) return [];
  return getAdjacentTiles(commander.gridX, commander.gridY).filter(
    (t) =>
      t.x >= 0 &&
      t.x < state.gridSize &&
      t.y >= 0 &&
      t.y < state.gridSize &&
      !getUnitAt(state, t.x, t.y),
  );
}

export function computeDamage(atk: number, def: number): number {
  return Math.max(1, atk - def);
}
