import {
  type GameState,
  type Phase,
  type UnderlingType,
  type Unit,
  UNDERLING_STATS,
  PHASE_ORDER,
  CASH_PER_TURN,
  getUnitAt,
  getDeployTiles,
  chebyshevDistance,
  computeDamage,
} from './gameState';

export interface DeployResult {
  ok: boolean;
  reason?: string;
  unit?: Unit;
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
  damage?: number;
  target?: Unit;
  killed?: boolean;
}

export type GameEvent =
  | { type: 'state-changed' }
  | { type: 'unit-deployed'; unit: Unit }
  | { type: 'unit-moved'; unit: Unit }
  | { type: 'unit-attacked'; attacker: Unit; target: Unit; damage: number; killed: boolean }
  | { type: 'phase-changed'; phase: Phase; playerIndex: number; turnNumber: number }
  | { type: 'unit-selected'; unit: Unit | null };

type Listener = (event: GameEvent) => void;

export class GameController {
  state: GameState;
  private listeners: Listener[] = [];
  selectedUnitId: number | null = null;
  armedDeployType: UnderlingType = 'Standard';

  constructor(state: GameState) {
    this.state = state;
  }

  subscribe(fn: Listener): void {
    this.listeners.push(fn);
  }

  private emit(event: GameEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  get activePlayer() {
    return this.state.players[this.state.activePlayerIndex];
  }

  getSelectedUnit(): Unit | null {
    if (this.selectedUnitId === null) return null;
    return this.state.units.find((u) => u.id === this.selectedUnitId) ?? null;
  }

  selectUnit(unit: Unit | null): void {
    this.selectedUnitId = unit ? unit.id : null;
    this.emit({ type: 'unit-selected', unit });
  }

  setDeployType(t: UnderlingType): void {
    this.armedDeployType = t;
    this.emit({ type: 'state-changed' });
  }

  canDeployHere(gx: number, gy: number): boolean {
    const tiles = getDeployTiles(this.state, this.activePlayer.id);
    return tiles.some((t) => t.x === gx && t.y === gy);
  }

  deploy(gx: number, gy: number): DeployResult {
    if (this.state.phase !== 'DEPLOY') return { ok: false, reason: 'Not in DEPLOY phase' };
    const t = this.armedDeployType;
    const stats = UNDERLING_STATS[t];
    if (this.activePlayer.cash < stats.cost) return { ok: false, reason: 'Not enough cash' };
    if (!this.canDeployHere(gx, gy)) return { ok: false, reason: 'Not a valid deploy tile' };

    const unit: Unit = {
      id: this.state.nextUnitId++,
      kind: 'underling',
      type: t,
      ownerId: this.activePlayer.id,
      gridX: gx,
      gridY: gy,
      hp: stats.hp,
      maxHp: stats.hp,
      atk: stats.atk,
      def: stats.def,
      hasActed: false,
    };
    this.state.units.push(unit);
    this.activePlayer.cash -= stats.cost;
    this.emit({ type: 'unit-deployed', unit });
    this.emit({ type: 'state-changed' });
    return { ok: true, unit };
  }

  canMoveHere(unit: Unit, gx: number, gy: number): boolean {
    if (unit.ownerId !== this.activePlayer.id) return false;
    if (gx < 0 || gx >= this.state.gridSize || gy < 0 || gy >= this.state.gridSize) return false;
    if (getUnitAt(this.state, gx, gy)) return false;
    return chebyshevDistance(unit.gridX, unit.gridY, gx, gy) === 1;
  }

  moveUnit(unit: Unit, gx: number, gy: number): boolean {
    if (!this.canMoveHere(unit, gx, gy)) return false;
    unit.gridX = gx;
    unit.gridY = gy;
    unit.hasActed = true;
    this.emit({ type: 'unit-moved', unit });
    this.emit({ type: 'state-changed' });
    return true;
  }

  canAttackHere(attacker: Unit, target: Unit): boolean {
    if (attacker.ownerId !== this.activePlayer.id) return false;
    if (attacker.ownerId === target.ownerId) return false;
    if (attacker.hasActed) return false;
    return chebyshevDistance(attacker.gridX, attacker.gridY, target.gridX, target.gridY) === 1;
  }

  attack(attacker: Unit, target: Unit): ActionResult {
    if (!this.canAttackHere(attacker, target)) return { ok: false, reason: 'Cannot attack' };
    const damage = computeDamage(attacker.atk, target.def);
    target.hp -= damage;
    attacker.hasActed = true;
    const killed = target.hp <= 0;
    if (killed) {
      this.state.units = this.state.units.filter((u) => u.id !== target.id);
      if (this.selectedUnitId === target.id) this.selectedUnitId = null;
    }
    this.emit({ type: 'unit-attacked', attacker, target, damage, killed });
    this.emit({ type: 'state-changed' });
    return { ok: true, damage, target, killed };
  }

  endPhase(): void {
    for (const u of this.state.units) {
      if (u.ownerId === this.activePlayer.id) u.hasActed = false;
    }
    this.selectUnit(null);

    const currentIdx = PHASE_ORDER.indexOf(this.state.phase);
    if (currentIdx < PHASE_ORDER.length - 1) {
      this.state.phase = PHASE_ORDER[currentIdx + 1];
    } else {
      this.state.phase = PHASE_ORDER[0];
      this.state.activePlayerIndex = (this.state.activePlayerIndex + 1) % this.state.players.length;
      if (this.state.activePlayerIndex === 0) this.state.turnNumber++;
      this.activePlayer.cash += CASH_PER_TURN;
    }
    this.emit({
      type: 'phase-changed',
      phase: this.state.phase,
      playerIndex: this.state.activePlayerIndex,
      turnNumber: this.state.turnNumber,
    });
    this.emit({ type: 'state-changed' });
  }
}
