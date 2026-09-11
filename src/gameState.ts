export type EntityType = 'Warlord' | 'Necromancer' | 'Engineer';

export interface Entity {
  id: number;
  type: EntityType;
  gridX: number;
  gridY: number;
}

export interface GameState {
  gridSize: number;
  grid: number[][];
  entities: Entity[];
}

const GRID_SIZE = 12;

function createGrid(): number[][] {
  const grid: number[][] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    const row: number[] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      row.push(0);
    }
    grid.push(row);
  }
  return grid;
}

export function createInitialState(): GameState {
  const grid = createGrid();
  const entities: Entity[] = [
    { id: 1, type: 'Warlord', gridX: 2, gridY: 2 },
    { id: 2, type: 'Necromancer', gridX: 6, gridY: 5 },
    { id: 3, type: 'Engineer', gridX: 9, gridY: 9 },
  ];
  return { gridSize: GRID_SIZE, grid, entities };
}

export function moveEntity(
  state: GameState,
  entityId: number,
  gridX: number,
  gridY: number,
): void {
  const entity = state.entities.find((e) => e.id === entityId);
  if (!entity) return;
  if (gridX < 0 || gridX >= state.gridSize || gridY < 0 || gridY >= state.gridSize)
    return;
  entity.gridX = gridX;
  entity.gridY = gridY;
}
